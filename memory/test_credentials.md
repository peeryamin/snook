# Test Credentials — Black Racks Snooker Club

## Admin Login
- URL: https://493f0dbf-f206-4d0f-a61f-4e9b28cbf0a8.preview.emergentagent.com/login.html
- Username: `admin`
- Password: `Zaid990340`

Auth flow:
1. POST `/api/auth/login` with `{ "username": "admin", "password": "Zaid990340" }`
2. Response includes `token` (JWT, 24h) and `sessionId`
3. All authed API calls require header `Authorization: Bearer <token>`
4. Logout: POST `/api/auth/logout` with `{ "sessionId": "..." }`

Only `admin` role can log in (any non-admin user gets 403).
