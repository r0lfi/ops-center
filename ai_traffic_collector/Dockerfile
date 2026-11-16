# Passive AI traffic collector (see src/main.rs). Built from this directory:
#   docker build -t ops-center/ai-traffic-collector:local ai_traffic_collector
# Built on the same AlmaLinux release as the runtime, so the binary links the
# runtime's libpcap.so.1 (Debian ships libpcap.so.0.8). Rust comes from AppStream,
# libpcap-devel from CRB.
FROM almalinux:10.2 AS build
RUN dnf -y install --enablerepo=crb rust cargo gcc libpcap-devel && dnf clean all
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo test --release --locked && cargo build --release --locked

# AlmaLinux 10.2 runtime per project policy; libpcap is the only runtime library.
FROM almalinux:10.2
RUN dnf -y upgrade && dnf -y install libpcap && dnf clean all && rm -rf /var/cache/dnf
COPY --from=build /src/target/release/ai-traffic-collector /usr/local/bin/ai-traffic-collector
# Runs as root inside the container only for the capabilities compose grants
# (NET_ADMIN to subscribe to conntrack events, NET_RAW to capture, SYS_PTRACE/
# DAC_READ_SEARCH to read /proc/<pid>/fd); everything else is dropped.
ENTRYPOINT ["/usr/local/bin/ai-traffic-collector"]
