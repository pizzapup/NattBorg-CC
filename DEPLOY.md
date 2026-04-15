# Production deployment

## 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL**: run the script in `supabase/migrations/001_production.sql` (SQL Editor → New query → paste → Run).
3. **Authentication → URL configuration**: add your production site URL and local dev URL (e.g. `http://localhost:5173`) to **Redirect URLs** and **Site URL**.
4. Enable **Email** provider (magic link) under Authentication → Providers.

## 2. Environment variables

Copy `.env.example` to `.env.local` and set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Rebuild after changing env (`npm run build`).

## 3. Static hosting

This app is a static SPA (Vite). Build with `npm run build` and deploy the `dist/` folder to Netlify, Vercel, Cloudflare Pages, S3+CloudFront, etc.

Configure the host to serve `index.html` for client-side routes. The app uses **hash** routing (`#generate`, `#studio`, `#play/slug`), so deep links work without server rewrite rules.

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
