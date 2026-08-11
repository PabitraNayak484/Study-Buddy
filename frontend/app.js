// ============================================================================
// Study Buddy — frontend logic
// ============================================================================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function setStatus(el, text, isError = false) {
  if (!text) { el.classList.add("hidden"); return; }
  el.textContent = text;
  el.classList.remove("hidden");
  el.classList.toggle("error", isError);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.setAttribute("aria-selected", "false"));
    tab.setAttribute("aria-selected", "true");
    const name = tab.dataset.tab;
    $$(".panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
  });
});

// ---------------------------------------------------------------------------
// Dark mode
// ---------------------------------------------------------------------------
const themeToggle = $("#theme-toggle");

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

let savedTheme = "light";
try { savedTheme = localStorage.getItem("study-buddy-theme") || "light"; } catch { /* ignore */ }
applyTheme(savedTheme);

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("study-buddy-theme", next); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Footer model badge
// ---------------------------------------------------------------------------
fetch("/api/health")
  .then((r) => r.json())
  .then((d) => { if (d.model) $("#model-name").textContent = d.model; })
  .catch(() => {});

// ---------------------------------------------------------------------------
// Custom Select Dropdowns
// ---------------------------------------------------------------------------
function initializeCustomSelects() {
  const selects = document.querySelectorAll("select");
  selects.forEach((select) => {
    // Hide original select
    select.style.display = "none";
    
    // Create wrapper
    const wrapper = document.createElement("div");
    wrapper.className = "custom-select-wrapper";
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select); // move select inside wrapper
    
    // Create selected display
    const customSelect = document.createElement("div");
    customSelect.className = "custom-select";
    customSelect.textContent = select.options[select.selectedIndex].textContent;
    wrapper.appendChild(customSelect);
    
    // Create options container
    const optionsContainer = document.createElement("div");
    optionsContainer.className = "custom-select-options";
    
    Array.from(select.options).forEach((option, index) => {
      const customOption = document.createElement("div");
      customOption.className = "custom-option";
      if (index === select.selectedIndex) customOption.classList.add("selected");
      customOption.textContent = option.textContent;
      
      customOption.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Update original select
        select.selectedIndex = index;
        // Trigger change event for any listeners
        select.dispatchEvent(new Event("change"));
        
        // Update custom UI
        customSelect.textContent = option.textContent;
        Array.from(optionsContainer.children).forEach(child => child.classList.remove("selected"));
        customOption.classList.add("selected");
        
        // Close dropdown
        optionsContainer.classList.remove("show");
        customSelect.classList.remove("active");
      });
      optionsContainer.appendChild(customOption);
    });
    
    wrapper.appendChild(optionsContainer);
    
    // Toggle dropdown on click
    customSelect.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation(); // prevent document click from immediately closing it
      
      // Close all other custom selects first
      document.querySelectorAll(".custom-select-options").forEach(el => {
        if (el !== optionsContainer) el.classList.remove("show");
      });
      document.querySelectorAll(".custom-select").forEach(el => {
        if (el !== customSelect) el.classList.remove("active");
      });
      
      optionsContainer.classList.toggle("show");
      customSelect.classList.toggle("active");
    });
  });
  
  // Close all custom selects when clicking outside
  document.addEventListener("click", () => {
    document.querySelectorAll(".custom-select-options").forEach(el => el.classList.remove("show"));
    document.querySelectorAll(".custom-select").forEach(el => el.classList.remove("active"));
  });
}
initializeCustomSelects();

// ---------------------------------------------------------------------------
// Pre-load Speech Synthesis Voices
// ---------------------------------------------------------------------------
if ("speechSynthesis" in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    window.speechSynthesis.getVoices();
  };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
const chatLog = $("#chat-log");
const chatForm = $("#chat-form");
const chatInput = $("#chat-input");
const chatSend = $("#chat-send");
const subjectInput = $("#subject-input");
const chatImageInput = $("#chat-image-input");
const chatAttachBtn = $("#chat-attach-btn");
const chatMicBtn = $("#chat-mic-btn");
const imagePreviewWrap = $("#image-preview-wrap");
const imagePreview = $("#image-preview");
const imageRemoveBtn = $("#image-remove");

// State tracking for the active chat session
let chatHistory = []; // Tracks messages to send to the backend
let attachedImage = null; // Currently attached image (base64 & mimeType)
let currentAborter = null; // Allows cancelling the active request

chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + "px";
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

// --- Image attachment ---
chatAttachBtn.addEventListener("click", () => chatImageInput.click());

chatImageInput.addEventListener("change", () => {
  const file = chatImageInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const base64 = String(dataUrl).split(",")[1] || "";
    attachedImage = { base64, mimeType: file.type };
    imagePreview.src = dataUrl;
    imagePreviewWrap.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
});

imageRemoveBtn.addEventListener("click", () => {
  attachedImage = null;
  chatImageInput.value = "";
  imagePreviewWrap.classList.add("hidden");
});

// --- Voice input ---
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;

if (!SpeechRecognitionCtor) {
  chatMicBtn.disabled = true;
  chatMicBtn.title = "Voice input isn't supported in this browser";
} else {
  recognition = new SpeechRecognitionCtor();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-US";

  recognition.addEventListener("result", (e) => {
    const transcript = Array.from(e.results).map((r) => r[0].transcript).join(" ");
    chatInput.value = chatInput.value ? `${chatInput.value} ${transcript}` : transcript;
    chatInput.dispatchEvent(new Event("input"));
  });
  recognition.addEventListener("end", () => {
    isListening = false;
    chatMicBtn.classList.remove("active");
  });
  recognition.addEventListener("error", () => {
    isListening = false;
    chatMicBtn.classList.remove("active");
  });

  chatMicBtn.addEventListener("click", () => {
    if (isListening) {
      recognition.stop();
      return;
    }
    try {
      recognition.start();
      isListening = true;
      chatMicBtn.classList.add("active");
    } catch {
    }
  });
}

// --- Voice output ---

function addReadAloudButton(bubble, text) {
  if (!("speechSynthesis" in window) || !text.trim()) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "read-aloud-btn";
  btn.textContent = "🔊 Read aloud";
  btn.addEventListener("click", () => {
    if (btn.classList.contains("speaking")) {
      window.speechSynthesis.cancel();
      btn.classList.remove("speaking");
      btn.textContent = "🔊 Read aloud";
      return;
    }
    window.speechSynthesis.cancel();
    
    const cleanText = text.replace(/[*#_`~>]/g, "");
    const utter = new SpeechSynthesisUtterance(cleanText);
    
    const voices = window.speechSynthesis.getVoices();
    const bestVoice = voices.find(v => v.lang.startsWith("en") && /natural|premium|google|online|aria|jenny|guy|siri|samantha/i.test(v.name)) 
                   || voices.find(v => v.lang === "en-US" || v.lang === "en-GB")
                   || voices.find(v => v.lang.startsWith("en"));
    if (bestVoice) {
      utter.voice = bestVoice;
    }
    
    utter.rate = 1.05;
    
    utter.onend = () => { btn.classList.remove("speaking"); btn.textContent = "🔊 Read aloud"; };
    btn.classList.add("speaking");
    btn.textContent = "⏹ Stop";
    window.speechSynthesis.speak(utter);
  });
  bubble.appendChild(document.createElement("br"));
  bubble.appendChild(btn);
}

function addMessage(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role === "user" ? "user" : "bot"}`;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (currentAborter) {
    currentAborter.abort();
    return;
  }

  const message = chatInput.value.trim();
  if (!message) return;

  addMessage("user", message);
  chatHistory.push({ role: "user", content: message });
  chatInput.value = "";
  chatInput.style.height = "auto";
  
  chatSend.textContent = "Stop";
  chatSend.classList.add("btn-stop");

  currentAborter = new AbortController();

  const sendingImage = attachedImage;
  imagePreviewWrap.classList.add("hidden");

  const botBubble = addMessage("assistant", "");
  botBubble.classList.add("streaming");
  let fullText = "";
  let hadError = false;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: currentAborter.signal,
      body: JSON.stringify({
        message,
        history: chatHistory.slice(0, -1),
        subject: subjectInput.value.trim() || null,
        image_data: sendingImage ? sendingImage.base64 : null,
        image_mime_type: sendingImage ? sendingImage.mimeType : null,
      }),
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || "Too many requests - please wait a moment.");
    }
    if (!res.ok || !res.body) {
      throw new Error(`Server responded with ${res.status}`);
    }

    // Setup reader to parse incoming Server-Sent Events
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by double newlines
      const frames = buffer.split("\n\n");
      buffer = frames.pop(); // Keep the last incomplete chunk in the buffer

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        try {
          const parsed = JSON.parse(payload);
          if (parsed.error) {
            fullText += `\n\n⚠️ ${parsed.error}`;
            hadError = true;
          } else if (parsed.text) {
            fullText += parsed.text;
          }
          botBubble.innerHTML = DOMPurify.sanitize(marked.parse(fullText));
          chatLog.scrollTop = chatLog.scrollHeight;
        } catch {
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      fullText += "\n\n*(Stopped by user)*";
      botBubble.innerHTML = DOMPurify.sanitize(marked.parse(fullText));
    } else {
      fullText += `\n\n⚠️ ${err.message}`;
      hadError = true;
      botBubble.innerHTML = DOMPurify.sanitize(marked.parse(fullText));
    }
  } finally {
    currentAborter = null;
    chatSend.textContent = "Send";
    chatSend.classList.remove("btn-stop");
    chatSend.disabled = false;
    botBubble.classList.remove("streaming");
    chatHistory.push({ role: "assistant", content: fullText });
    // Keep history trimmed to the backend's Pydantic limit
    if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
    attachedImage = null;
    chatImageInput.value = "";
    if (!hadError) addReadAloudButton(botBubble, fullText);
  }
});

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------
const quizForm = $("#quiz-form");
const quizStatus = $("#quiz-status");
const quizResults = $("#quiz-results");
const quizGenerateBtn = $("#quiz-generate");
const quizSummaryEl = $("#quiz-summary");
const autoDifficultyCheckbox = $("#quiz-auto-difficulty");
const lastScoreBadge = $("#last-score-badge");

let lastScorePercent = null;
let currentQuizAborter = null;

function updateLastScoreBadge() {
  if (lastScorePercent === null) { lastScoreBadge.classList.add("hidden"); return; }
  lastScoreBadge.textContent = `Last score: ${lastScorePercent}%`;
  lastScoreBadge.classList.remove("hidden");
}

quizForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (currentQuizAborter) {
    currentQuizAborter.abort();
    return;
  }

  const topic = $("#quiz-topic").value.trim();
  if (!topic) return;

  quizResults.innerHTML = "";
  quizSummaryEl.classList.add("hidden");
  
  quizGenerateBtn.textContent = "Stop";
  quizGenerateBtn.classList.add("btn-stop");
  setStatus(quizStatus, "Writing your quiz...");

  currentQuizAborter = new AbortController();

  try {
    const res = await fetch("/api/quiz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Use a composite signal: manual cancel OR 90s hard timeout
      signal: AbortSignal.any
        ? AbortSignal.any([currentQuizAborter.signal, AbortSignal.timeout(90_000)])
        : currentQuizAborter.signal,
      body: JSON.stringify({
        topic,
        num_questions: Number($("#quiz-count").value),
        difficulty: $("#quiz-difficulty").value,
        auto_difficulty: autoDifficultyCheckbox.checked,
        previous_score_percent: lastScorePercent,
      }),
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || "Too many requests - please wait a moment.");
    }
    if (!res.ok) throw new Error((await res.json()).detail || `Server error ${res.status}`);
    const data = await res.json();
    renderQuiz(data.questions || [], data.difficulty_used);
    const usedNote = data.difficulty_used && autoDifficultyCheckbox.checked
      ? ` (auto-set to ${data.difficulty_used} difficulty)`
      : "";
    setStatus(quizStatus, data.questions && data.questions.length ? `Quiz ready${usedNote}.` : "");
  } catch (err) {
    if (err.name === "AbortError") {
      setStatus(quizStatus, "Quiz generation stopped.");
    } else {
      setStatus(quizStatus, `Couldn't generate the quiz: ${err.message}`, true);
    }
  } finally {
    currentQuizAborter = null;
    quizGenerateBtn.textContent = "Generate quiz";
    quizGenerateBtn.classList.remove("btn-stop");
    quizGenerateBtn.disabled = false;
  }
});

function renderQuiz(questions, difficultyUsed) {
  const total = questions.length;
  const state = { answered: 0, correct: 0, missed: [] };

  questions.forEach((q, i) => {
    const card = document.createElement("div");
    card.className = "quiz-card";

    const num = document.createElement("div");
    num.className = "q-num";
    num.textContent = `Question ${i + 1} of ${total}`;
    card.appendChild(num);

    const qText = document.createElement("div");
    qText.className = "q-text";
    qText.textContent = q.question;
    card.appendChild(qText);

    const optionsWrap = document.createElement("div");
    optionsWrap.className = "q-options";

    const explanation = document.createElement("div");
    explanation.className = "q-explanation";
    explanation.textContent = q.explanation || "";

    (q.options || []).forEach((opt, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "q-option";
      btn.textContent = opt;
      btn.addEventListener("click", () => {
        if (optionsWrap.dataset.answered) return;
        optionsWrap.dataset.answered = "true";
        const isCorrect = idx === q.correct_index;
        $$(".q-option", optionsWrap).forEach((b, i2) => {
          if (i2 === q.correct_index) b.classList.add("correct");
        });
        if (!isCorrect) {
          btn.classList.add("incorrect");
          state.missed.push({ front: q.question, back: q.explanation || "(No explanation provided.)" });
        } else {
          state.correct += 1;
        }
        explanation.classList.add("show");
        state.answered += 1;
        if (state.answered === total) showQuizSummary(state, total, difficultyUsed);
      });
      optionsWrap.appendChild(btn);
    });

    card.appendChild(optionsWrap);
    card.appendChild(explanation);
    quizResults.appendChild(card);
  });
}

function showQuizSummary(state, total, difficultyUsed) {
  const pct = Math.round((state.correct / total) * 100);
  lastScorePercent = pct;
  updateLastScoreBadge();

  quizSummaryEl.innerHTML = "";
  quizSummaryEl.classList.remove("hidden");

  const scoreText = document.createElement("span");
  scoreText.className = "score-text";
  scoreText.textContent = `You scored ${state.correct}/${total} (${pct}%)${difficultyUsed ? ` at ${difficultyUsed} difficulty` : ""}.`;
  quizSummaryEl.appendChild(scoreText);

  if (state.missed.length) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `Add ${state.missed.length} missed question${state.missed.length > 1 ? "s" : ""} to flashcards`;
    btn.addEventListener("click", () => {
      renderFlashcards(state.missed, { append: true, fromReview: true });
      const cardsTab = $('.tab[data-tab="cards"]');
      if (cardsTab) cardsTab.click();
      btn.disabled = true;
      btn.textContent = "Added ✓";
    });
    quizSummaryEl.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Notes -> Summary / Flashcards
// ---------------------------------------------------------------------------
const notesForm = $("#notes-form");
const notesStatus = $("#notes-status");
const summaryOutput = $("#summary-output");
const flashcardDeck = $("#flashcard-deck");
const notesInput = $("#notes-input");
const notesFileInput = $("#notes-file-input");
const notesUploadBtn = $("#notes-upload-btn");
const deckActions = $("#deck-actions");
const exportAnkiBtn = $("#export-anki-btn");
const printDeckBtn = $("#print-deck-btn");

let currentDeckCards = [];

notesForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitter = e.submitter;
  const mode = submitter ? submitter.dataset.mode : "summary";
  const text = notesInput.value.trim();
  if (!text) return;

  summaryOutput.classList.add("hidden");
  summaryOutput.textContent = "";
  flashcardDeck.innerHTML = "";
  deckActions.classList.add("hidden");
  currentDeckCards = [];
  $$(".notes-btn").forEach((b) => (b.disabled = true));
  setStatus(notesStatus, mode === "flashcards" ? "Building your flashcards..." : "Summarizing...");

  try {
    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout ? AbortSignal.timeout(90_000) : undefined,
      body: JSON.stringify({ text, mode }),
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || "Too many requests - please wait a moment.");
    }
    if (!res.ok) throw new Error((await res.json()).detail || `Server error ${res.status}`);
    const data = await res.json();

    if (mode === "flashcards") {
      renderFlashcards(data.flashcards || []);
    } else {
      summaryOutput.innerHTML = DOMPurify.sanitize(marked.parse(data.summary || ""));
      summaryOutput.classList.remove("hidden");
    }
    setStatus(notesStatus, "");
  } catch (err) {
    setStatus(notesStatus, `Something went wrong: ${err.message}`, true);
  } finally {
    $$(".notes-btn").forEach((b) => (b.disabled = false));
  }
});

function renderFlashcards(cards, opts = {}) {
  const { append = false, fromReview = false } = opts;
  if (!append) {
    flashcardDeck.innerHTML = "";
    currentDeckCards = [];
  }
  cards.forEach((c) => {
    const card = document.createElement("div");
    card.className = "flashcard";

    const inner = document.createElement("div");
    inner.className = "flashcard-inner";

    const front = document.createElement("div");
    front.className = "flashcard-face front" + (fromReview ? " from-review" : "");
    const frontText = document.createElement("span");
    frontText.textContent = c.front;
    const frontHint = document.createElement("span");
    frontHint.className = "flashcard-hint";
    frontHint.textContent = "tap to flip";
    front.appendChild(frontText);
    front.appendChild(frontHint);

    const back = document.createElement("div");
    back.className = "flashcard-face back";
    const backText = document.createElement("span");
    backText.textContent = c.back;
    const backHint = document.createElement("span");
    backHint.className = "flashcard-hint";
    backHint.textContent = "tap to flip back";
    back.appendChild(backText);
    back.appendChild(backHint);

    inner.appendChild(front);
    inner.appendChild(back);
    card.appendChild(inner);

    card.addEventListener("click", () => card.classList.toggle("flipped"));
    flashcardDeck.appendChild(card);
  });
  currentDeckCards = currentDeckCards.concat(cards);
  deckActions.classList.toggle("hidden", currentDeckCards.length === 0);
}

// --- File upload ---
notesUploadBtn.addEventListener("click", () => notesFileInput.click());

notesFileInput.addEventListener("change", async () => {
  const file = notesFileInput.files[0];
  if (!file) return;

  notesUploadBtn.disabled = true;
  setStatus(notesStatus, `Reading ${file.name}...`);

  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/extract", {
      method: "POST",
      signal: AbortSignal.timeout ? AbortSignal.timeout(90_000) : undefined,
      body: formData,
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || "Too many requests - please wait a moment.");
    }
    if (!res.ok) throw new Error((await res.json()).detail || `Server error ${res.status}`);
    const data = await res.json();
    notesInput.value = data.text || "";
    setStatus(notesStatus, `Loaded text from ${file.name}. Review it below, then Summarize or Make flashcards.`);
  } catch (err) {
    setStatus(notesStatus, `Couldn't read that file: ${err.message}`, true);
  } finally {
    notesUploadBtn.disabled = false;
    notesFileInput.value = "";
  }
});

// --- Export / print the current flashcard deck ---
function sanitizeForTsv(str) {
  return (str || "").replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
}

exportAnkiBtn.addEventListener("click", () => {
  if (!currentDeckCards.length) return;
  const lines = currentDeckCards.map((c) => `${sanitizeForTsv(c.front)}\t${sanitizeForTsv(c.back)}`);
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "study-buddy-flashcards.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

printDeckBtn.addEventListener("click", () => window.print());

// ---------------------------------------------------------------------------
// Study Timer (Client-side Pomodoro)
// ---------------------------------------------------------------------------
const timerDisplay = $("#timer-display");
const timerModeLabel = $("#timer-mode-label");
const timerStartBtn = $("#timer-start");
const timerPauseBtn = $("#timer-pause");
const timerResetBtn = $("#timer-reset");
const presetBtns = $$(".preset-btn");

let focusMinutes = 25;
let breakMinutes = 5;
let remainingSeconds = focusMinutes * 60;
let isBreak = false;
let timerInterval = null;

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function updateTimerDisplay() {
  timerDisplay.textContent = formatTime(remainingSeconds);
  timerModeLabel.textContent = isBreak ? "Break time" : "Focus session";
}

// Use a single, reused AudioContext to avoid hitting browser instance limits
let _audioCtx = null;
function _getAudioCtx() {
  if (!_audioCtx || _audioCtx.state === "closed") {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _audioCtx;
}

function playBeep() {
  try {
    const ctx = _getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch {
  }
}

function notifyTimerSwitch() {
  const message = isBreak ? "Break time! Step away for a bit." : "Break's over - back to focus.";
  if ("Notification" in window) {
    if (Notification.permission === "granted") {
      new Notification("Study Buddy", { body: message });
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission();
    }
  }
  playBeep();
}

function tick() {
  // Check completion first to avoid displaying -1 seconds
  if (remainingSeconds <= 0) {
    isBreak = !isBreak;
    remainingSeconds = (isBreak ? breakMinutes : focusMinutes) * 60;
    notifyTimerSwitch();
  } else {
    remainingSeconds -= 1;
  }
  updateTimerDisplay();
}

timerStartBtn.addEventListener("click", () => {
  if (timerInterval) return;
  timerInterval = setInterval(tick, 1000);
  timerStartBtn.classList.add("hidden");
  timerPauseBtn.classList.remove("hidden");
});

timerPauseBtn.addEventListener("click", () => {
  clearInterval(timerInterval);
  timerInterval = null;
  timerPauseBtn.classList.add("hidden");
  timerStartBtn.textContent = "Resume";
  timerStartBtn.classList.remove("hidden");
});

timerResetBtn.addEventListener("click", () => {
  clearInterval(timerInterval);
  timerInterval = null;
  isBreak = false;
  remainingSeconds = focusMinutes * 60;
  timerStartBtn.textContent = "Start";
  timerStartBtn.classList.remove("hidden");
  timerPauseBtn.classList.add("hidden");
  updateTimerDisplay();
});

presetBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    presetBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    focusMinutes = Number(btn.dataset.focus);
    breakMinutes = Number(btn.dataset.break);
    clearInterval(timerInterval);
    timerInterval = null;
    isBreak = false;
    remainingSeconds = focusMinutes * 60;
    timerStartBtn.textContent = "Start";
    timerStartBtn.classList.remove("hidden");
    timerPauseBtn.classList.add("hidden");
    updateTimerDisplay();
  });
});

// Default to the first preset ("25 / 5") being visually active.
if (presetBtns.length) presetBtns[0].classList.add("active");
updateTimerDisplay();
