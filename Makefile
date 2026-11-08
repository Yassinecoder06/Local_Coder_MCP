.PHONY: setup up down logs tunnel e2e test

setup:
	./scripts/setup.sh

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

tunnel:
	docker compose --profile tunnel up -d tunnel
	./scripts/tunnel-url.sh

e2e:
	./scripts/e2e.sh

test:
	npm run typecheck
	npm test
