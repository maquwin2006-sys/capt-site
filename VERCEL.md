# Кабинет на Vercel

Сайт работает на Vercel как функция. Аккаунты берёт из MySQL игрового сервера (на VPS), музыку хранит в **Vercel Blob**.
Игра проигрывает музыку по ссылкам `https://capt-site.vercel.app/files/<файл>` — сайт перенаправляет их на файл в Blob.

## 1. Хранилище музыки (Vercel Blob)

1. Vercel → проект **capt-site** → вкладка **Storage** → **Create** → **Blob**.
2. Доступ — **Public** (иначе игра не сможет проиграть трек).
3. **Connect** к проекту capt-site (для Production и Preview). Переменная `BLOB_READ_WRITE_TOKEN` появится сама.

## 2. MySQL на VPS: доступ для сайта

Vercel заходит в базу из интернета с меняющихся адресов, поэтому нужен отдельный пользователь
с минимальными правами и шифрованием. На VPS:

```sql
CREATE USER 'capt_site'@'%' IDENTIFIED BY 'длинный_случайный_пароль' REQUIRE SSL;
GRANT SELECT (id, name, pass, salt, elo, wins, losses, kills, deaths, money, skin, donate, fitness, admin, audio, reg_date, last_login),
      UPDATE (pass, salt)
      ON capt.accounts TO 'capt_site'@'%';
GRANT ALL PRIVILEGES ON capt.audio_tracks TO 'capt_site'@'%';
FLUSH PRIVILEGES;
```

Перед этим один раз запустите новый гейммод (update 7) — он создаст таблицу `audio_tracks` и столбец `accounts.audio`.

Затем разрешите внешние подключения:

- в конфиге MySQL (`/etc/mysql/mysql.conf.d/mysqld.cnf` или `my.ini` на Windows): `bind-address = 0.0.0.0`, перезапустите MySQL;
- откройте порт **3306/TCP** в фаерволе VPS / панели хостинга;
- MySQL 8 сам создаёт сертификаты для SSL — проверьте: `SHOW VARIABLES LIKE 'have_ssl';` → `YES`.

`root` наружу не открывайте: игровой сервер продолжает ходить в базу как раньше, через 127.0.0.1.

## 3. Переменные окружения

Vercel → capt-site → **Settings → Environment Variables**:

| Переменная | Значение |
|---|---|
| `DB_HOST` | IP вашего VPS |
| `DB_PORT` | `3306` |
| `DB_USER` | `capt_site` |
| `DB_PASS` | пароль из шага 2 |
| `DB_NAME` | `capt` |
| `DB_SSL` | `1` |
| `SESSION_SECRET` | не обязательно: если не задан, ключ берётся из секрета Blob |
| `BLOB_READ_WRITE_TOKEN` | появляется сам после шага 1 |

После изменения переменных: **Deployments → … → Redeploy**.

## 4. Проверка

- `https://capt-site.vercel.app` — страница входа. Если сайт не настроен, при входе будет понятная ошибка
  («подключите хранилище Vercel Blob», «нет связи с базой игрового сервера»).
- Войти ником и паролем от игры → Аудиозаписи → загрузить трек (сначала в игре `/makeaudio` за рулём).
- В игре: C в машине → трек в списке → играет.

## Ограничения

- Файл до 25 МБ, до 20 треков и 300 МБ на игрока (`MAX_FILE_MB`, `MAX_TRACKS`, `MAX_TOTAL_MB`).
- Если закрыть страницу посреди загрузки, файл может остаться в Blob без записи в базе — его видно и можно удалить во вкладке Storage.
- Бесплатный тариф Vercel Blob ограничен по объёму и трафику: музыку качает каждый игрок, который её слышит.
