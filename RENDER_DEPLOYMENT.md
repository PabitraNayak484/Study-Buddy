
## 1. Push Your Code to GitHub
Render needs to pull your code from a GitHub repository.

1. Go to [GitHub.com](https://github.com/) and create a free account if you don't have one.
2. In the top right corner, click the **+** icon and select **New repository**.
3. Name it something like `study-buddy-app` and choose **Public** or **Private**. Click **Create repository**.
4. Open a terminal on your computer in your project folder (`c:\Users\pabit\Downloads\SIP project\V2\study-buddy-app-v2\study-assistant`) and run these commands to push your code:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/study-buddy-app.git
   git push -u origin main
   ```
   *(Be sure to replace the `https://...` URL above with the actual URL GitHub gave you).*

---

## 2. Connect to Render
Now that your code is on GitHub, it's time to connect Render.

1. Go to [Render.com](https://render.com) and click **Get Started** to create a free account.
2. Sign up using your GitHub account. This makes it easy for Render to see your repositories.
3. Once you are logged into the Render Dashboard, click the **New** button in the top right corner.
4. Select **Blueprint** from the dropdown menu.

---

## 3. Deploy the App
Because I created a `render.yaml` Blueprint file for you, Render already knows exactly how to build and host your app!

1. On the "Connect a repository" screen, you will see a list of your GitHub repos. Find your `study-buddy-app` repository and click **Connect**.
2. Render will automatically read the `render.yaml` file.
3. It will bring you to a screen asking you to enter your **Environment Variables**.
4. Find the box labeled `GEMINI_API_KEY`. Paste your actual Google Gemini API key into this box. *(Render will keep this completely hidden and secure).*
5. Click the **Apply** button at the bottom of the screen.

---

## 4. Wait for the Build
1. You will be taken to a dashboard page where a black terminal window will start streaming text. This is Render downloading your code and building the Docker container on their servers.
2. This usually takes about **3 to 5 minutes**. 
3. When it is finished, you will see a log message that says `Uvicorn running on http://0.0.0.0:8000`. This means your app is live!

---

## 5. Get Your Live URL
1. At the very top left of your Render dashboard, just under the name of your app, you will see a link that looks like this: `https://study-buddy-app-xxxx.onrender.com`.
2. Click it! That is your live, public HTTPS URL. You can share this link with anyone or submit it for your project!

---
*Note: Because this uses Render's Free Tier, your app will automatically "go to sleep" if nobody visits the URL for 15 minutes. When you (or your teacher) visit the URL after it goes to sleep, the page will take about 50 seconds to load while the container wakes back up. This is completely normal for free hosting!*
