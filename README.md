# motomotaapp-backend
MotoMota API Backend



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