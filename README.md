
# ACS Salary Calculator - Deployment Guide

This guide will walk you through deploying your application to a live website using GitHub and Netlify.

## Step 1: Create a GitHub Repository

1.  Go to [GitHub](https://github.com/) and log in.
2.  Click the **+** icon in the top right and select **"New repository"**.
3.  Give your repository a name (e.g., `acs-salary-app`).
4.  Choose "Public" or "Private".
5.  Click **"Create repository"**.

## Step 2: Upload Your Project Files

On your new repository page, you will upload all the files for the app.

1.  Click the **"Add file"** button and select **"Upload files"**.
2.  Drag and drop all of the following files into the upload area:
    *   `index.html`
    *   `index.css`
    *   `index.tsx`
    *   `package.json`
    *   `vite.config.ts`
    *   `tsconfig.json`
    *   `tsconfig.node.json`
    *   `README.md` (this file)
3.  Once all files are uploaded, scroll down and click **"Commit changes"**.

## Step 3: Deploy with Netlify

1.  Go to [Netlify](https://www.netlify.com/) and sign up or log in (you can use your GitHub account for this).
2.  On your dashboard, click **"Add new site"** -> **"Import an existing project"**.
3.  Click on the **GitHub** button to connect Netlify to your GitHub account.
4.  Search for and select the repository you just created (`acs-salary-app`).

## Step 4: Configure Build Settings & Environment Variables

This is the most important step. Netlify needs to know how to build your site and needs your secret Supabase keys.

1.  **Build Settings:** Netlify should automatically detect you are using Vite. Ensure the settings are:
    *   **Build command:** `npm run build`
    *   **Publish directory:** `dist`

2.  **Environment Variables (Crucial for Security):**
    *   Before deploying, click on **"Show advanced"**, then **"New variable"**.
    *   You need to add your two Supabase keys here. This keeps them secure and out of your code.
    *   **Variable 1:**
        *   **Key:** `VITE_SUPABASE_URL`
        *   **Value:** Paste your Supabase Project URL here (e.g., `https://ksubndttngntzmkafmdq.supabase.co`)
    *   **Variable 2:**
        *   **Key:** `VITE_SUPABASE_ANON_KEY`
        *   **Value:** Paste your Supabase `anon` public key here.

## Step 5: Launch!

1.  Click the **"Deploy site"** button.

Netlify will now pull your code from GitHub, install all the dependencies from `package.json`, run the build command, and deploy the resulting `dist` folder to their global network.

Within a few minutes, your site will be live! You can find the URL on your Netlify project dashboard. From now on, whenever you push changes to your files on GitHub, Netlify will automatically rebuild and redeploy your site.
