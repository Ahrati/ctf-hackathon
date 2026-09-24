## 1. Baza Podataka (MariaDB)

| .. | Key |
| :--- | :--- |
| **Korisnik (User)** | `ctfd` |
| **Lozinka (Password)** | `ctfd_password` |
| **Ime Baze (Database)** | `ctfd` |
| **Root Korisnik** | `root` |
| **Root Lozinka** | `ctfd_root_password` |
| **Host (unutar Dockera)** | `db` |
| **Port (unutar Dockera)** | `3306` |

### Connection Strings:
- **Za CTFd (Python/SQLAlchemy):**  
  `mysql+pymysql://ctfd:ctfd_password@db/ctfd`
- **Za Bun App (Node/mysql2):**  
  `mysql://ctfd:ctfd_password@db:3306/ctfd`

### CTFd Admin

| .. | Key |
| :--- | :--- |
| **User** | `admin` |
| **Password** | `password` |
