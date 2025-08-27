# mirrormaster-arch

# MirrorMaster Arch

## Example Caddy config

```
# Serve the mirror directory at http://yourdomain/mirror/
yourdomain.com

root * /path/to/mirrormaster/mirror
file_server browse
```

Or to serve at a subpath (e.g. `/archlinux/`):

```
yourdomain.com

handle_path /archlinux/* {
    root * /path/to/mirrormaster/mirror
    file_server browse
}
```

## Example Nginx config

```
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
