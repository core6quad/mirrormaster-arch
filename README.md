# mirrormaster-arch

# MirrorMaster Arch

[![GitHub stars](https://img.shields.io/github/stars/core6quad/mirrormaster-arch?style=flat-square)](https://github.com/core6quad/mirrormaster-arch/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/core6quad/mirrormaster-arch?style=flat-square)](https://github.com/core6quad/mirrormaster-arch/issues)
[![License](https://img.shields.io/github/license/core6quad/mirrormaster-arch?style=flat-square)](https://github.com/core6quad/mirrormaster-arch/blob/main/LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/core6quad/mirrormaster-arch?style=flat-square)](https://github.com/core6quad/mirrormaster-arch/commits/main)

> Fast, configurable, multi-mirror Arch Linux repository mirroring tool with a web admin panel.

---

## Features

- **Fast**: Multi-threaded downloads, each worker uses a different mirror.
- **Web Admin Panel**: Real-time progress, logs, and controls via the Web panel with classic material ui
- **Full Structure**: Mirrors the real Arch repo structure (core, extra, community, multilib, etc).
-  **Configurable**: Choose which top-level folders to mirror, speed limits, and more via `.env`.
-  **Easy to Serve**: Example configs for Caddy and Nginx included.

---

## Quick Start

## docker compose

it's very easy, you can figure it out!

## without docker

### WARNING!!!!!!!!! DO NOT open the admin panel port to the public, there is no auth!!!!!

1. **Clone the repo:**
   ```sh
   git clone https://github.com/core6quad/mirrormaster-arch.git
   cd mirrormaster-arch
   ```

2. **Install dependencies:**
   ```sh
   npm install
   ```

3. **Configure `.env`:**
   - Edit `.env` to set your preferred mirrors, folders, and options.
   - Example:
     ```
     MIRRORS=https://mirror.rackspace.com/archlinux,https://mirror.yandex.ru/archlinux
     MIRROR_INCLUDE_FOLDERS=core,extra,community,multilib
     DOWNLOAD_SPEED_LIMIT_KBPS=102400
     MULTITHREADED=true
     ```

4. **Run the app:**
   ```sh
   node index.js
   ```

5. **Open the web admin:**
   - Go to [http://localhost:3000/admin](http://localhost:3000/admin)

---

## Example Caddy config

```caddyfile
# Serve the mirror directory at http://yourdomain/mirror/
yourdomain.com

root * /path/to/mirrormaster/mirror
file_server browse
```

Or to serve at a subpath (e.g. `/archlinux/`):

```caddyfile
yourdomain.com

handle_path /archlinux/* {
    root * /path/to/mirrormaster/mirror
    file_server browse
}
```

## Example Nginx config

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # Serve at http://yourdomain.com/archlinux/
    location /archlinux/ {
        alias /path/to/mirrormaster/mirror/;
        autoindex on;
        # Optional: allow large files
        client_max_body_size 10G;
    }
}
```

Replace `/path/to/mirrormaster/mirror` with the absolute path to your `mirror` directory.

---

## Environment Variables

| Variable                  | Description                                              | Example/Default                        |
|---------------------------|---------------------------------------------------------|----------------------------------------|
| `ADMIN_PORT`              | Port for web admin interface                            | `3000`                                 |
| `MIRRORS`                 | Comma-separated list of mirror URLs                     | `https://mirror.rackspace.com/archlinux,https://mirror.yandex.ru/archlinux` |
| `ARCH`                    | Architecture to sync                                    | `x86_64`                               |
| `FILE_TIMEOUT_MS`         | Timeout (ms) after each file download                   | `0`                                    |
| `DOWNLOAD_SPEED_LIMIT_KBPS` | Download speed limit in KB/s (-1 = no limit)           | `102400`                               |
| `MULTITHREADED`           | Enable multithreaded download (`true`/`false`)          | `true`                                 |
| `MIRROR_INCLUDE_FOLDERS`  | Top-level folders to mirror (comma-separated)           | `core,extra,community,multilib`        |

---

## Notes

- **AUR is not supported. yet...** Only official Arch repositories are mirrored.
- If you want to serve your mirror, use the Caddy or Nginx configs above.
- For best performance, use as many fast mirrors as possible and enable multithreading. (not Too many, it may lag or stutter, read .env for more)

---

## License

[MIT](LICENSE)
