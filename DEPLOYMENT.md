# Deploying Study Buddy to AWS

This guide walks through deploying the container to **AWS Elastic
Beanstalk**, then putting a **CloudFront** distribution in front of it so
the app is reachable on a real public **HTTPS** URL — satisfying the
project's "live AWS deployment" and "public HTTPS URL" requirements.

> **Why Elastic Beanstalk instead of App Runner?**
> As of this writing, **AWS App Runner is closed to new customers**
> (effective April 30, 2026 — see AWS's [availability change notice](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)).
> Existing App Runner customers can keep using it as normal, but a fresh
> student AWS account generally cannot create a *new* App Runner service.
> The project brief explicitly lists Elastic Beanstalk as an accepted
> alternative, so that's the primary path below. If you already have App
> Runner enabled on your account, see the short **Appendix: App Runner**
> at the end instead — the container itself is identical either way.

---

## 0. Prerequisites

- An AWS account (the [AWS Free Tier](https://aws.amazon.com/free/) covers
  everything here for a student project).
- The Gemini API key from `.env` (see the main [README](./README.md)).
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  installed and configured (`aws configure`) with an IAM user that has
  programmatic access.
- The **EB CLI**: `pip install awsebcli --user`
- Docker (only needed if you want to test the image locally first).

## 1. Set a budget alert first (cost awareness)

Before creating anything, set a safety net:

1. AWS Console → **Billing and Cost Management** → **Budgets** → **Create budget**.
2. Choose **Zero spend budget** (or a small monthly amount, e.g. $5) →
   add your email for alerts.
3. Save. You'll now get an email if AWS charges start accumulating.

Everything below fits inside the AWS Free Tier for a single low-traffic
student project (Elastic Beanstalk itself is free — you only pay for the
underlying EC2/S3 resources, and a `t3.micro` or `t2.micro` instance is
free-tier eligible for the first 12 months of a new account).

## 2. Initialize Elastic Beanstalk

From the project root (where the `Dockerfile` lives):

```bash
eb init
```

Answer the prompts:
- **Region**: pick the one closest to you (e.g. `us-east-1`)
- **Application name**: `study-buddy`
- **Platform**: `Docker` → `Docker running on 64bit Amazon Linux 2023`
- **CodeCommit**: No (unless you specifically want it)
- **SSH**: optional, Yes if you'd like to be able to SSH into the instance

This creates a local `.elasticbeanstalk/config.yml` (safe to commit — it
has no secrets).

## 3. Create the environment

A **single-instance** environment (no load balancer) is the cheapest option
and is enough for a class project:

```bash
eb create study-buddy-env --single --instance-type t3.micro
```

This zips your project (respecting `.elasticbeanstalk/config.yml`'s
ignore rules — add a `.ebignore` if you want to exclude anything extra),
uploads it, and has Elastic Beanstalk build your `Dockerfile` and run the
container. This step takes several minutes the first time.

## 4. Set your secrets as environment variables

Never put the real API key in the Dockerfile or in git. Set it directly
on the Elastic Beanstalk environment instead:

```bash
eb setenv GEMINI_API_KEY=your-real-key-here GEMINI_MODEL=gemini-2.5-flash
```

Optional: also set `RATE_LIMIT_PER_MINUTE` (default 12) if you expect a
larger showcase audience and want to raise or lower the per-visitor cap, e.g.:
```bash
eb setenv GEMINI_API_KEY=your-real-key-here RATE_LIMIT_PER_MINUTE=20
```

This restarts the environment with the variable available to the
container (the app reads it via `os.environ` in `backend/main.py`).

## 5. Verify it's running

```bash
eb open
```

This opens something like `http://study-buddy-env.<random>.<region>.elasticbeanstalk.com`
in your browser — note it's **HTTP** at this point. Confirm the app loads,
try the chat/quiz/flashcards tabs, then continue to the next step for HTTPS.

If something's wrong, check logs first:
```bash
eb logs
eb health
```

## 6. Add HTTPS with CloudFront

Elastic Beanstalk's own default domain doesn't serve HTTPS out of the box
(AWS can't issue a certificate for a domain you don't own). The standard,
zero-cost fix is to put a CloudFront distribution in front of it —
CloudFront automatically gives you a `https://xxxxxxxx.cloudfront.net`
URL with a valid, trusted AWS certificate, no custom domain required.

1. AWS Console → **CloudFront** → **Create distribution**.
2. **Origin domain**: paste your Elastic Beanstalk URL from step 5
   (e.g. `study-buddy-env.xxxxx.us-east-1.elasticbeanstalk.com`).
3. **Origin protocol policy**: HTTP only (since that's what EB serves).
4. **Viewer protocol policy**: **Redirect HTTP to HTTPS**.
5. **Allowed HTTP methods**: GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE
   (the app needs POST for `/api/chat`, `/api/quiz`, `/api/summarize`).
6. **Cache policy**: use **CachingDisabled** (this is a dynamic API-backed
   app, not a static site — you don't want cached API responses).
7. Leave the rest as defaults and **Create distribution**.
8. Wait for the distribution status to become "Enabled" (a few minutes),
   then open the provided `https://xxxxxxxx.cloudfront.net` URL.

**This is the public HTTPS URL you paste into your Concept Note and
Project Report.**

## 7. Redeploying after code changes

```bash
eb deploy
```

CloudFront will keep serving from the same URL — no need to touch it
again unless you change the origin.

## 8. Tearing it down (avoid surprise charges when you're done)

```bash
eb terminate study-buddy-env
```

Then delete the CloudFront distribution from the console (disable it
first, then delete once disabled).

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `502 Bad Gateway` from the app | Usually a missing/invalid `GEMINI_API_KEY` — re-check `eb setenv`, then `eb logs`. |
| `eb create` fails immediately | Check IAM permissions; the CLI needs Elastic Beanstalk, EC2, S3, and CloudFormation permissions. |
| Site loads over CloudFront but API calls fail | Confirm you allowed POST/PATCH methods and disabled caching on the CloudFront behavior. |
| Streaming chat "sticks" or arrives all at once | Some proxies buffer SSE; the app already sends `X-Accel-Buffering: no`, but if you add a load balancer later, confirm it doesn't buffer responses. |

---

## Appendix: If you already have AWS App Runner access

If your AWS account already has App Runner enabled (existing customers
are unaffected by the April 2026 change), it's genuinely simpler:

1. Push the image to Amazon ECR:
   ```bash
   aws ecr create-repository --repository-name study-buddy
   aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com
   docker build -t study-buddy .
   docker tag study-buddy:latest <account-id>.dkr.ecr.<region>.amazonaws.com/study-buddy:latest
   docker push <account-id>.dkr.ecr.<region>.amazonaws.com/study-buddy:latest
   ```
2. AWS Console → **App Runner** → **Create service** → source = **Container registry** → select the ECR image.
3. Set **Port** to `8000`.
4. Under **Environment variables**, add `GEMINI_API_KEY` and (optionally) `GEMINI_MODEL`.
5. Deploy. App Runner gives you a ready-to-use `https://xxxxx.<region>.awsapprunner.com` URL automatically — no CloudFront step needed.
