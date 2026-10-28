# Security

MajaOS runs as root and manages disks, VMs and containers, so security problems matter. Thank you for reporting them responsibly.

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private reporting instead: [Report a vulnerability](https://github.com/lennertvh1/MajaOS/security/advisories/new) (the *Security* tab of the repository).

Include what you found, how to reproduce it, and which version or commit you tested. You'll get an answer within a week. Once a fix is released, the advisory is published with credit to you, unless you prefer otherwise.

## Supported versions

Only the latest release and the `dev` branch get security fixes.

## Running MajaOS safely

- Create your account right after installing: until there is one, anyone who reaches the server can create it.
- Turn on two-step verification (*Settings → Security*).
- Don't forward MajaOS's ports on your router. For access from outside, use a VPN such as WireGuard or Tailscale, or the remote access tunnel in MajaOS.
- Leave the terminal and SSH off unless you need them.
