# ctf

### Startup

docker-compose is required.

(run from project folder)
```bash
    docker compose up -d --build
```

then connect to localhost:5473

to add users to the system:

Administrator
```
    docker compose exec app bun run user:add -- USERNAME admin "ADMIN NAME"
```

Contestant
```
    docker compose exec app bun run user:add -- USERNAME team "TEAM NAME"
```

after which you are prompted to give it a password.

to shut it down:
```bash
    docker compose down
```

### Leaderboard

```
    localhost:5473/tv
```
