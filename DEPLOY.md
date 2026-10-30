# Развёртывание на VPS

Сайт личного кабинета Capt DM — это постоянный Node.js/Express-процесс с MySQL и
загрузкой файлов на диск. Его правильное место — VPS рядом с игровым сервером и его
базой (не serverless-платформы вроде Vercel). Инструкция для Ubuntu 22.04/24.04.

## 1. Подготовить сервер

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git nginx
sudo npm install -g pm2
```

Проверь: `node -v` должно быть 18+.

## 2. Забрать код

Репозиторий приватный — на сервере нужен доступ (deploy key или PAT):

```bash
cd /var/www
git clone https://github.com/maquwin2006-sys/capt-site.git
cd capt-site
npm install
```

## 3. База данных

Сайт логинит игроков по **той же** базе, что и игра — таблица `accounts`
(поля `name, pass, salt, elo, wins, losses, kills, deaths, reg_date, last_login`).
Отдельную БД поднимать не надо, дай доступ к игровой:

```sql
CREATE USER 'capt_site'@'127.0.0.1' IDENTIFIED BY 'надёжный_пароль';
GRANT SELECT ON игровая_бд.accounts TO 'capt_site'@'127.0.0.1';
GRANT ALL ON игровая_бд.audio_tracks TO 'capt_site'@'127.0.0.1';
FLUSH PRIVILEGES;
```

Таблицу `audio_tracks` сервер создаёт сам при первом запуске.

## 4. Переменные окружения

Создай файл `.env` рядом с `server.js` (он в `.gitignore`, в репозиторий не попадёт):

```bash
PORT=3000
DB_HOST=127.0.0.1
DB_USER=capt_site
DB_PASS=надёжный_пароль
DB_NAME=игровая_бд
SESSION_SECRET=<результат `openssl rand -hex 32`>
MAX_FILE_MB=25
MAX_TRACKS=30
MAX_TOTAL_MB=300
```

`SESSION_SECRET` **обязателен** и ≥16 символов, иначе сервер сразу завершится
(`process.exit(1)`). `openssl rand -hex 32` даст хорошую случайную строку.

> `server.js` подхватывает `.env` автоматически (через `dotenv`), поэтому достаточно
> положить файл рядом с ним. Экспортировать переменные вручную не нужно.

## 5. Запуск через pm2

```bash
pm2 start server.js --name capt-site
pm2 save
pm2 startup        # выполни команду, которую он выведет — автозапуск при ребуте
```

Логи: `pm2 logs capt-site`. Если видишь «Не удалось подключиться к MySQL» —
проверь доступы из шага 3.

## 6. Nginx + HTTPS

Сайт слушает `127.0.0.1:3000`, наружу его выставляет nginx. Подними лимит тела
запроса под загрузку файлов (до 25 МБ — ставим с запасом 30m):

```nginx
server {
    server_name capt.твойдомен.ru;
    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`X-Forwarded-*` важны: в коде стоит `app.set('trust proxy', true)` — по ним работают
защита от брутфорса (лимит 10 попыток / 10 мин на IP) и флаг `Secure` у cookie.

HTTPS-сертификат бесплатно через certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d capt.твойдомен.ru
```

Certbot сам допишет 443-й блок и редирект с http.

## 7. Проверка

Открой `https://capt.твойдомен.ru`, войди ником и паролем игрового аккаунта,
загрузи mp3/ogg. Файлы лягут в `uploads/`, раздаются по
`https://capt.твойдомен.ru/files/<имя>` — именно эти ссылки проигрывает игровой сервер.

## Обновление и эксплуатация

- Обновить версию: `git pull && npm install && pm2 restart capt-site`.
- Папку `uploads/` не трогай руками и держи вне git (уже в `.gitignore`).
- Пароль MySQL и `SESSION_SECRET` — только в `.env` на сервере, не коммить.
