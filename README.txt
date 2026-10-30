САЙТ КАБИНЕТА Capt DM
Нужен Node.js 18+ и доступ к той же MySQL-базе, что и у игрового сервера.
1) npm install
2) Задать переменные окружения как в .env.example (например: export DB_PASS=... SESSION_SECRET=... ) и запустить: node server.js
   Для постоянной работы: pm2 start server.js --name capt-site
3) Поставить перед сайтом nginx с HTTPS (proxy_pass на порт 3000, client_max_body_size 30m).
4) Таблица audio_tracks создаётся сама. Файлы лежат в папке uploads/ и раздаются по /files/<имя>.
Вход на сайт: ник и пароль игрового аккаунта (проверка SHA256 + соль, как в игре).
