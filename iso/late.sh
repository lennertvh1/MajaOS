#!/bin/sh
# Last step of the Debian installer (preseed/late_command), in the installer's environment.
# / is the installer, /target the new system, /cdrom the ISO (or USB stick).
# Puts HomeBaseOS in place; installing happens at the first boot (homebaseos-firstboot.service),
# because ZFS builds a kernel module for the kernel that is really running then.
set -e
SRC=/cdrom/homebaseos

mkdir -p /target/opt/homebaseos-setup
cp "$SRC/homebaseos.tar.gz" /target/tmp/homebaseos.tar.gz
in-target tar -xzf /tmp/homebaseos.tar.gz -C /opt/homebaseos-setup
rm -f /target/tmp/homebaseos.tar.gz

# Chosen in the boot menu: "Install HomeBaseOS with NVIDIA".
if grep -q 'homebaseos.nvidia=1' /proc/cmdline; then touch /target/opt/homebaseos-setup/.nvidia; fi

cp "$SRC/homebaseos-firstboot.service" /target/etc/systemd/system/homebaseos-firstboot.service
in-target systemctl enable homebaseos-firstboot.service

# The server's screen (above the login prompt) shows what is happening.
mkdir -p /target/etc/issue.d
cp "$SRC/installing.issue" /target/etc/issue.d/homebaseos.issue
