# Production deployment

## 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL**: run the script in `supabase/migrations/001_production.sql` (SQL Editor → New query → paste → Run).
3. **Authentication → URL configuration**: add your production site URL and local dev URL (e.g. `http://localhost:5173`) to **Redirect URLs** and **Site URL**.
4. Enable **Email** provider (magic link) under Authentication → Providers.

## 2. Environment variables

Copy `.env.example` to `.env.local` and set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY` — the **anon public** key from **Project Settings → API**. Do **not** use the **service_role** key in the app or Vercel env (the browser will show *Forbidden use of secret API key*).

Rebuild after changing env (`npm run build`).

## 3. Static hosting

This app is a static SPA (Vite). Build with `npm run build` and deploy the `dist/` folder to Netlify, Vercel, Cloudflare Pages, S3+CloudFront, etc.

Configure the host to serve `index.html` for client-side routes. The app uses **hash** routing (`#generate`, `#studio`, `#play/slug`), so deep links work without server rewrite rules.

### Hosting on Vercel

1. Push the repo to GitHub (or GitLab / Bitbucket).
2. In [vercel.com](https://vercel.com) → **Add New… → Project** → import that repo.
3. Vercel should detect **Vite** automatically. Confirm:
   - **Framework Preset**: Vite (or “Other” with **Build Command** `npm run build` and **Output Directory** `dist`).
   - **Root Directory**: leave default (repository root) unless the app lives in a subfolder.
4. **Environment Variables** (Project → Settings → Environment Variables): add for **Production** (and **Preview** if you want preview deploys to hit Supabase):
   - `VITE_SUPABASE_URL` = your Supabase project URL  
   - `VITE_SUPABASE_ANON_KEY` = Supabase **anon** key (not service_role)
5. Deploy. Your site will be at something like `https://your-project.vercel.app`.
6. **Supabase Auth**: In Supabase → **Authentication → URL configuration**, add:
   - **Site URL**: `https://your-project.vercel.app` (your real Vercel URL).
   - **Redirect URLs**: the same URL plus `https://your-project.vercel.app/**` if the dashboard suggests wildcards, and keep `http://localhost:5173` for local dev.

After the first deploy, magic links and published play links must use the **production** origin (or players will still hit localhost if you copied an old link).

## 4. Player links

Authors publish from **System studio → Backup → Share character generator**.

- **Public / unlisted**: `https://yoursite.com/#play/your-slug`
- **Invite**: `https://yoursite.com/?k=SECRET#play/your-slug` (secret is shown after publish)

## 5. Local-only mode

If `VITE_SUPABASE_*` are unset, the app runs in **local mode**: all data stays in `localStorage`, and the studio does not require sign-in. Use this for offline development only; production should set Supabase.

## 6. Security notes

- Row Level Security in the migration restricts `designer_systems` and `published_generators` to owners.
- Players load published JSON only through the `fetch_published_generator` RPC (no direct table read for anonymous users).
- Never commit `.env` or service role keys to git.
