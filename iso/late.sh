#!/bin/sh
# Laatste stap van de Debian-installer (preseed/late_command), in de omgeving van de installer.
# / is de installer, /target het nieuwe systeem, /cdrom de ISO (of USB-stick).
# Zet HomeBaseOS klaar; installeren gebeurt bij de eerste opstart (homebaseos-firstboot.service),
# want ZFS bouwt een kernelmodule voor de kernel die dan echt draait.
set -e
SRC=/cdrom/homebaseos

mkdir -p /target/opt/homebaseos-setup
cp "$SRC/homebaseos.tar.gz" /target/tmp/homebaseos.tar.gz
in-target tar -xzf /tmp/homebaseos.tar.gz -C /opt/homebaseos-setup
rm -f /target/tmp/homebaseos.tar.gz

# Gekozen in het opstartmenu: "HomeBaseOS installeren met NVIDIA".
if grep -q 'homebaseos.nvidia=1' /proc/cmdline; then touch /target/opt/homebaseos-setup/.nvidia; fi

cp "$SRC/homebaseos-firstboot.service" /target/etc/systemd/system/homebaseos-firstboot.service
in-target systemctl enable homebaseos-firstboot.service

# Op het scherm van de server (boven de aanmeldregel) staat wat er gebeurt.
mkdir -p /target/etc/issue.d
cp "$SRC/installing.issue" /target/etc/issue.d/homebaseos.issue
