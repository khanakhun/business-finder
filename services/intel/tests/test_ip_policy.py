from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network, ip_address, ip_network

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.net.ip_policy import blocked_reason

BLOCKED_V4 = [
    "0.0.0.0/8",  # "this network"
    "10.0.0.0/8",
    "100.64.0.0/10",  # carrier-grade NAT
    "127.0.0.0/8",
    "169.254.0.0/16",  # link-local, cloud metadata
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",  # documentation
    "192.168.0.0/16",
    "198.18.0.0/15",  # benchmarking
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",  # multicast
    "240.0.0.0/4",  # reserved, broadcast
]
BLOCKED_V6 = [
    "::/128",
    "::1/128",
    "fc00::/7",  # unique local (includes AWS fd00:ec2::254)
    "fe80::/10",  # link-local
    "ff00::/8",  # multicast
    "2001:db8::/32",  # documentation
    "2001::/32",  # Teredo
    "100::/64",  # discard-only
]
PUBLIC_V4 = ["8.8.8.0/24", "1.1.1.0/24", "93.184.215.0/24", "151.101.0.0/16"]
PUBLIC_V6 = ["2001:4860::/32", "2606:4700::/32", "2a00:1450::/32"]


def addresses_in(cidr: str) -> st.SearchStrategy[IPv4Address | IPv6Address]:
    network = ip_network(cidr)
    first, last = int(network.network_address), int(network.broadcast_address)
    factory = IPv4Address if isinstance(network, IPv4Network) else IPv6Address
    return st.integers(min_value=first, max_value=last).map(factory)


def any_of(cidrs: list[str]) -> st.SearchStrategy[IPv4Address | IPv6Address]:
    return st.one_of(*(addresses_in(c) for c in cidrs))


@given(any_of(BLOCKED_V4 + BLOCKED_V6))
def test_non_public_addresses_are_blocked(address: IPv4Address | IPv6Address) -> None:
    assert blocked_reason(address) is not None


@given(any_of(PUBLIC_V4 + PUBLIC_V6))
def test_public_addresses_are_allowed(address: IPv4Address | IPv6Address) -> None:
    assert blocked_reason(address) is None


@given(any_of(BLOCKED_V4))
def test_ipv6_forms_embedding_a_blocked_ipv4_are_blocked(inner: IPv4Address | IPv6Address) -> None:
    v4 = int(inner)
    mapped = IPv6Address((0xFFFF << 32) | v4)  # ::ffff:a.b.c.d
    nat64 = IPv6Address(int(IPv6Network("64:ff9b::/96").network_address) | v4)
    six_to_four = IPv6Address((0x2002 << 112) | (v4 << 80))
    for address in (mapped, nat64, six_to_four):
        reason = blocked_reason(address)
        assert reason is not None, address
        assert reason.split()[0] in ("IPv4-mapped", "NAT64", "6to4")


@pytest.mark.parametrize("address", ["192.0.0.9", "192.0.0.10", "::ffff:192.0.0.9"])
def test_ietf_protocol_anycast_addresses_are_blocked(address: str) -> None:
    # Global per Python 3.13's IANA table, but refused with the rest of 192.0.0.0/24.
    assert blocked_reason(ip_address(address)) is not None


@given(any_of(PUBLIC_V4))
def test_ipv6_forms_embedding_a_public_ipv4_are_allowed(inner: IPv4Address | IPv6Address) -> None:
    assert blocked_reason(IPv6Address((0xFFFF << 32) | int(inner))) is None


@pytest.mark.parametrize(
    ("address", "reason"),
    [
        ("127.0.0.1", "loopback address"),
        ("169.254.169.254", "cloud metadata address"),
        ("fd00:ec2::254", "cloud metadata address"),
        ("100.100.100.200", "cloud metadata address"),
        ("10.0.0.5", "private address"),
        ("::1", "loopback address"),
        ("::ffff:127.0.0.1", "IPv4-mapped loopback address"),
        ("::ffff:169.254.169.254", "IPv4-mapped cloud metadata address"),
        ("0.0.0.0", "unspecified address"),
        ("100.64.0.1", "non-global address"),
        ("2001::1", "Teredo tunnel address"),
        ("224.0.0.1", "multicast address"),
    ],
)
def test_names_the_reason(address: str, reason: str) -> None:
    assert blocked_reason(ip_address(address)) == reason
