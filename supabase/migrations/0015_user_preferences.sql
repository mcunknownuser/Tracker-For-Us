                                                                                        -- 0015_user_preferences.sql
                                                                                        -- Per-user UI preferences (column visibility, layout choices, etc.).
                                                                                        -- Stored as a single jsonb so we can add new keys without migrations.
                                                                                        --
                                                                                        -- Scope: one row per auth user. Preferences travel with the user across
                                                                                        -- agencies — they are UI/UX choices, not agency data.
                                                                                        --
                                                                                        -- Why jsonb: settings are a moving target. We want to add new keys
                                                                                        -- (tracking column visibility, table sort, theme, etc.) without a
                                                                                        -- schema migration each time.

                                                                                        create table if not exists public.user_preferences (
                                                                                          user_id     uuid primary key references auth.users(id) on delete cascade,
                                                                                          prefs       jsonb not null default '{}'::jsonb,
                                                                                          created_at  timestamptz not null default now(),
                                                                                          updated_at  timestamptz not null default now()
                                                                                        );

                                                                                        drop trigger if exists user_preferences_touch_updated_at on public.user_preferences;
                                                                                        create trigger user_preferences_touch_updated_at
                                                                                          before update on public.user_preferences
                                                                                          for each row execute function public.touch_updated_at();

                                                                                        alter table public.user_preferences enable row level security;

                                                                                        drop policy if exists user_preferences_self on public.user_preferences;
                                                                                        create policy user_preferences_self on public.user_preferences
                                                                                          for all to authenticated
                                                                                          using       (user_id = auth.uid())
                                                                                          with check  (user_id = auth.uid());
