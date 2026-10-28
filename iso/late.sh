#!/bin/sh
# Last step of the Debian installer (preseed/late_command), in the installer's environment.
# / is the installer, /target the new system, /cdrom the ISO (or USB stick).
# Puts MajaOS in place; installing happens at the first boot (majaos-firstboot.service),
# because ZFS builds a kernel module for the kernel that is really running then.
set -e
SRC=/cdrom/majaos

mkdir -p /target/opt/majaos-setup
cp "$SRC/majaos.tar.gz" /target/tmp/majaos.tar.gz
in-target tar -xzf /tmp/majaos.tar.gz -C /opt/majaos-setup
rm -f /target/tmp/majaos.tar.gz

# Chosen in the installer: the NVIDIA checkbox, and the language of the screen.
if grep -q 'majaos.nvidia=1' /proc/cmdline; then touch /target/opt/majaos-setup/.nvidia; fi
LANG_CODE="$(sed -n 's/.*majaos\.lang=\([a-z][a-z]*\).*/\1/p' /proc/cmdline | head -1)"
if [ -n "$LANG_CODE" ]; then
  mkdir -p /target/var/lib/majaos
  printf '{"language":"%s"}\n' "$LANG_CODE" > /target/var/lib/majaos/settings.json
  chmod 600 /target/var/lib/majaos/settings.json
fi
# The installer set a random password so Debian would not ask. Lock it: the account is created in the browser.
in-target passwd -l maja || true

cp "$SRC/majaos-firstboot.service" /target/etc/systemd/system/majaos-firstboot.service
in-target systemctl enable majaos-firstboot.service

# The server's screen (above the login prompt) shows what is happening.
mkdir -p /target/etc/issue.d
cp "$SRC/installing.issue" /target/etc/issue.d/majaos.issue
