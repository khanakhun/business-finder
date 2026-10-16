"""Which IP addresses outbound requests may reach (security.md §4: SSRF).

Only globally routable unicast addresses are allowed. Addresses that embed an IPv4 address (IPv4-mapped,
NAT64, 6to4) are judged by the embedded address, so `::ffff:127.0.0.1` is loopback. The same rules apply to
Playwright request interception in BF-026.
"""

from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network, ip_address

type IPAddress = IPv4Address | IPv6Address

_NAT64 = IPv6Network("64:ff9b::/96")  # RFC 6052 well-known prefix: last 32 bits are an IPv4 address
_SIX_TO_FOUR = IPv6Network("2002::/16")  # RFC 3056: bits 16-48 are an IPv4 address
_TEREDO = IPv6Network("2001::/32")  # RFC 4380 tunnels: the client address is obfuscated, refuse outright
# RFC 6890 IETF protocol assignments. Python 3.13 marks 192.0.0.9/.10 (PCP/TURN anycast) global; no website
# lives there, so the whole block stays refused.
_IETF_PROTOCOL = IPv4Network("192.0.0.0/24")

# Named for clearer errors; every one of these is also caught by the generic checks below.
_CLOUD_METADATA = frozenset(
    {
        ip_address("169.254.169.254"),  # AWS, GCP, Azure, DigitalOcean, OpenStack
        ip_address("169.254.170.2"),  # AWS ECS task metadata
        ip_address("100.100.100.200"),  # Alibaba Cloud
        ip_address("fd00:ec2::254"),  # AWS IMDS over IPv6
    }
)

# Checked in order; the first match names the reason.
_CATEGORIES = (
    ("is_unspecified", "unspecified address"),
    ("is_loopback", "loopback address"),
    ("is_link_local", "link-local address"),
    ("is_multicast", "multicast address"),
    ("is_private", "private address"),
    ("is_reserved", "reserved address"),
)


def blocked_reason(ip: IPAddress) -> str | None:
    """Why `ip` must not be contacted, or None when it is a public unicast address."""
    if isinstance(ip, IPv6Address):
        if embedded := _embedded_ipv4(ip):
            kind, inner = embedded
            reason = blocked_reason(inner)
            return f"{kind} {reason}" if reason else None
        if ip in _TEREDO:
            return "Teredo tunnel address"
    if ip in _CLOUD_METADATA:
        return "cloud metadata address"
    if isinstance(ip, IPv4Address) and ip in _IETF_PROTOCOL:
        return "IETF protocol assignment"
    for flag, reason in _CATEGORIES:
        if getattr(ip, flag):
            return reason
    # e.g. 100.64.0.0/10 (carrier-grade NAT), which is neither private nor global.
    return None if ip.is_global else "non-global address"


def _embedded_ipv4(ip: IPv6Address) -> tuple[str, IPv4Address] | None:
    if ip.ipv4_mapped is not None:
        return "IPv4-mapped", ip.ipv4_mapped
    if ip in _NAT64:
        return "NAT64", IPv4Address(int(ip) & 0xFFFF_FFFF)
    if ip in _SIX_TO_FOUR and ip.sixtofour is not None:
        return "6to4", ip.sixtofour
    return None
