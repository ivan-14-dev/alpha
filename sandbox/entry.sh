#!/bin/sh
# Alpha sandbox entry script (POSIX sh, BusyBox compatible). Runs INSIDE the container as uid 65534, network-less,
# with a read-only root filesystem. Mounted read-only at /sandbox/entry.sh (bind mode) or passed with `sh -c` (stdin mode).
#
#   1. copies the build into /work/build/<name> (from /input, or from stdin with an exact size check);
#   2. extracts .zip / .tar.gz / .tgz / .tar archives into /work/app when ALPHA_EXTRACT=1;
#   3. resolves the `{entry}` argument from ALPHA_ENTRY_CANDIDATES (relative paths, first match wins);
#   4. execs the profile command with an in-container KILL watchdog (ALPHA_TIMEOUT seconds), stdin closed.
#
# Setup failures print a line prefixed with [alpha-sandbox] and exit with status 121.
set -eu
umask 077

fail() {
  printf '[alpha-sandbox] %s\n' "$*" >&2
  exit 121
}

name="${ALPHA_INPUT_NAME:-}"
case "$name" in
  '' | .* | */* | *[!A-Za-z0-9._-]*) fail "Nom de build invalide." ;;
esac

build_dir=/work/build
app_dir=/work/app
mkdir -p "$build_dir" "$app_dir" || fail "Espace de travail /work indisponible."
build="$build_dir/$name"

case "${ALPHA_INPUT_MODE:-bind}" in
  stdin)
    size="${ALPHA_INPUT_SIZE:-}"
    case "$size" in '' | *[!0-9]*) fail "Taille du build invalide." ;; esac
    head -c "$size" > "$build" || fail "Lecture du build impossible (espace /work insuffisant ?)."
    actual=$(wc -c < "$build" | tr -d ' ')
    [ "$actual" = "$size" ] || fail "Transfert du build incomplet ($actual/$size octets)."
    ;;
  bind)
    [ -f "/input/$name" ] || fail "Build introuvable dans /input."
    cp "/input/$name" "$build" || fail "Copie du build impossible (espace /work insuffisant ?)."
    ;;
  *) fail "Mode de transmission inconnu." ;;
esac
chmod 0700 "$build"

kind=none
if [ "${ALPHA_EXTRACT:-0}" = 1 ]; then
  case "$name" in
    *.zip | *.ZIP | *.jar.zip) kind=zip ;;
    *.tar.gz | *.tgz | *.TAR.GZ | *.TGZ) kind=targz ;;
    *.tar | *.TAR) kind=tar ;;
  esac
fi

# Archive members cannot escape the container: the only writable places are the /work and /tmp tmpfs mounts,
# whose size bounds decompression bombs. Ownership and setuid bits are not restored (unprivileged user, nosuid).
case "$kind" in
  zip)
    if command -v unzip > /dev/null 2>&1; then
      unzip -q -o "$build" -d "$app_dir" > /dev/null || fail "Extraction de l'archive ZIP impossible (archive invalide ou espace insuffisant)."
    elif command -v busybox > /dev/null 2>&1; then
      busybox unzip -q -o "$build" -d "$app_dir" > /dev/null || fail "Extraction de l'archive ZIP impossible."
    else
      fail "unzip est absent de l'image de ce profil."
    fi
    ;;
  targz) tar -xzf "$build" -C "$app_dir" 2> /dev/null || fail "Extraction de l'archive tar.gz impossible (archive invalide ou espace insuffisant)." ;;
  tar) tar -xf "$build" -C "$app_dir" 2> /dev/null || fail "Extraction de l'archive tar impossible (archive invalide ou espace insuffisant)." ;;
esac

root="$build_dir"
entry="$build"
if [ "$kind" != none ]; then
  root="$app_dir"
  # An archive holding a single top-level directory (project-1.0/...) is entered transparently.
  count=0
  only=""
  for item in "$app_dir"/* "$app_dir"/.[!.]*; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    count=$((count + 1))
    only="$item"
  done
  if [ "$count" = 1 ] && [ -d "$only" ] && [ ! -L "$only" ]; then root="$only"; fi
  entry=""
  for candidate in ${ALPHA_ENTRY_CANDIDATES:-}; do
    case "$candidate" in /* | *..*) continue ;; esac
    if [ -f "$root/$candidate" ]; then
      entry="$root/$candidate"
      break
    fi
  done
fi

cd "$root" || fail "Répertoire de travail inaccessible."

# Rebuild argv: substitute {entry}; a script without shebang used as the program itself is run through /bin/sh.
needs_entry=0
for arg in "$@"; do
  if [ "$arg" = "{entry}" ]; then needs_entry=1; fi
done
if [ "$needs_entry" = 1 ]; then
  [ -n "$entry" ] || fail "Aucun point d'entrée trouvé dans l'archive (attendu : ${ALPHA_ENTRY_CANDIDATES:-aucun})."
  chmod u+x "$entry" 2> /dev/null || true
fi
count=$#
index=0
while [ "$index" -lt "$count" ]; do
  arg="$1"
  shift
  if [ "$arg" = "{entry}" ]; then
    if [ "$index" = 0 ]; then
      magic=$(head -c 4 "$entry" 2> /dev/null | tr -d '\000' || true)
      case "$magic" in
        '#!'* | "$(printf '\177ELF')") ;;
        *) set -- "$@" /bin/sh ;;
      esac
    fi
    arg="$entry"
  fi
  set -- "$@" "$arg"
  index=$((index + 1))
done

[ "$#" -gt 0 ] || fail "Commande vide."
timeout_s="${ALPHA_TIMEOUT:-}"
case "$timeout_s" in '' | *[!0-9]*) timeout_s="" ;; esac
if [ -n "$timeout_s" ] && command -v timeout > /dev/null 2>&1; then
  exec timeout -s KILL "$timeout_s" "$@" < /dev/null
fi
exec "$@" < /dev/null
