#!/usr/bin/env bash
# OFFLINE-STUB(online-porting #898): cloud nodes switch to Calico; live verification runs on EC2 k3s.
# Install the pinned Calico CNI on a cloud k3s cluster started with
#   flannel-backend: none   and   disable-network-policy: true
# (k3s server config; see ../README.md), then apply the global metadata deny.
# NOT used by the dev path: install-dev.sh keeps flannel + kube-router.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$HERE/versions.env"
kubectl apply -f "$CALICO_MANIFEST_URL"
kubectl -n kube-system rollout status ds/calico-node --timeout=300s
kubectl -n kube-system set env ds/calico-node FELIX_FLOWLOGSFILEENABLED=true
kubectl apply -f "$HERE/global-deny-sandbox-metadata.yaml"
