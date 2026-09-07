# POS / ERP MVP

Bitta do‘kon uchun katalog → ombor → kassa → mijoz → nasiya (halol) → kunlik hisobot.

Stack: **Node.js + Express + Postgres (`pg`)**.

Qoidalar:
- Serial/IMEI yo‘q — faqat `qty`.
- Penya/ustama/foiz yo‘q. Overdue faqat status.
- Nasiya bo‘lsa `customer_id` **majburiy**.
- Installment jadvali sotuvdan keyin kiritilishi mumkin (`credit_status = schedule_pending`).
- Jadval yo‘q bo‘lsa overdue hisoblanmaydi.
- To‘lov FIFO: eng eski `due_date`.
- Schema’da `locations` bor (do‘kon + ombor).
- Sale’da `location_id` (kontekst) va `source_location_id` (stock qayerdan kamayadi) alohida.
- `has_delivery=true` → `deliveries` row. Stock baribir darrov `sale_out`.

## Papka

```
pos-erp-mvp/
  sql/001_init.sql
  sql/002_delivery_transfer.sql
  scripts/init-db.js
  scripts/seed.js
  src/
    index.js
    db.js
    lib/
    middleware/auth.js
    routes/
  http/examples.http
  .env.example
```

## Ishga tushirish

```bash
cp .env.example .env
# DATABASE_URL va JWT_SECRET ni to'ldiring

createdb pos_erp   # yoki docker postgres
npm install
npm run db:init
npm run db:seed
npm run dev
```

Docker Postgres misol:

```bash
docker run -d --name pos-pg \
  -e POSTGRES_USER=pos \
  -e POSTGRES_PASSWORD=pos_secret \
  -e POSTGRES_DB=pos_erp \
  -p 5432:5432 postgres:16
```

Seed:
- phone: `998901234567`
- password: `admin123`
- role: `owner`

## Endpointlar

| Method | Path | Role |
|---|---|---|
| POST | `/auth/login` | public |
| GET | `/me` | any |
| GET/POST/PATCH | `/products` | GET any; yozish owner/warehouse |
| POST | `/inventory/in` | owner/warehouse |
| POST | `/inventory/adjust` | owner/warehouse |
| POST | `/inventory/transfer` | owner/warehouse |
| GET | `/inventory/balance?location_id=` | any |
| GET | `/alerts/restock?store_location_id=&warehouse_location_id=` | any |
| GET/PATCH | `/deliveries` | PATCH owner/seller/warehouse |
| GET/POST/PATCH | `/customers` | yozish owner/seller |
| GET | `/customers/:id/ledger` | any |
| POST/GET | `/sales` | POST owner/seller |
| GET | `/sales/:id` | any |
| POST | `/sales/:id/installments` | owner/seller |
| POST | `/credit/payments` | owner/seller |
| GET | `/credit/schedule-pending` | owner |
| GET | `/credit/overdue` | owner/seller |
| GET | `/reports/daily?date=YYYY-MM-DD` | any |
| GET | `/reports/owner-overview` | owner |

HTTP misollar: `http/examples.http`.

## Muhim biznes qarorlar (MVP)

1. Nasiya = mijoz majburiy. Aks holda `customer_required_for_credit`.
2. Installment faqat bir marta: `credit_status` `schedule_pending` bo‘lmasa blok.
3. `SUM(amount_due) == sales.credit_total`.
4. Overpay blok: `amount_exceeds_balance`.
5. Stock yetmasa sale rad (`insufficient_stock`). Test uchun `allow_negative_stock: true`.
6. `credit_payments.sale_id` ixtiyoriy. Berilsa avval o‘sha sale installmentlari, qolgani boshqa sale’larga FIFO.
7. Stock `source_location_id` dan kamayadi (1.A, rezerv yo‘q).
8. `has_delivery` stockdan mustaqil: do‘kondan ham, ombordan ham delivery bo‘lishi mumkin.
9. Qoldiq `inventory_balance` cache. Har movement transactionda yangilanadi. Audit uchun `inventory_movements` source of truth.

## Mix sale modellari

| source_location | has_delivery | Ma’nosi |
|---|---|---|
| store | false | Mijoz olib ketdi |
| store | true | Do‘kondan berildi, uyga eltildi |
| warehouse | true | Ombordan berildi va yetkazildi |
| warehouse | false | Ombordan berildi, mijoz o‘zi oldi |

## Multi-store

Seed 2 location yaratadi: do‘kon + ombor. Yangi filial = yangi `locations` row. Keyin user–location bog‘lash jadvali qo‘shiladi.

## Keyingi bosqich TODO

- [ ] Chek / PDF print
- [ ] Returns (`return_in` + sale cancel qoidalari)
- [ ] Expenses
- [ ] Shift / kassa ochish-yopish
- [ ] User CRUD + location assignment
- [ ] Nightly cron: overdue status
- [ ] Soft-delete / audit log
- [ ] Credit limit enforcement (ixtiyoriy)
- [ ] Pagination + tests
