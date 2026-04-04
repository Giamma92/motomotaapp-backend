# motomotaapp-backend
MotoMota API Backend

## Telegram notifications

To enable Telegram notifications for saved lineups, configure these environment variables:

```env
TELEGRAM_NOTIFICATIONS_ENABLED=true
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_group_chat_id
```

When enabled, the backend sends a Telegram group message after every successful `lineups` save.



#Supabase

1) Install supabase 

if you install supabase as dev dependecy use "pnpm exec" instead only "pnpm"
```
pnpm install -g supabase
```
2) use to init supabase
```
pnpm supabase init
```

3) login in supabase

```
pnpm supabase login
```

4) create a function
```
pnpm supabase functions new motogp-scraper
```

5) publish a function in your project
```
pnpm supabase functions deploy motogp-scraper --project-ref <project-id>
```
