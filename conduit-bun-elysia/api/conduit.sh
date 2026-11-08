#!/usr/bin/env bash
# curl CLI for the Conduit API.
#
#   api/conduit.sh test                          # run every endpoint, check status codes and responses
#   api/conduit.sh call METHOD PATH [TOKEN] [SAMPLE|JSON]
#       api/conduit.sh call GET /api/tags
#       api/conduit.sh call GET /api/user 5
#       api/conduit.sh call POST /api/articles 5 create-article.json
#       api/conduit.sh call POST /api/users/login '' '{"user":{"email":"user7@example.com","password":"password123"}}'
#
# Env: BASE_URL (default http://127.0.0.1:3000), VERBOSE=1 prints every response body.
# Tokens are user ids (seeded users: 1..100000, password `password123`). Sample bodies live in api/samples/;
# `__RUN__` in them is replaced by a unique run id so `test` can run repeatedly against the same database.
set -uo pipefail

BASE=${BASE_URL:-http://127.0.0.1:3000}
DIR=$(cd "$(dirname "$0")" && pwd)
RUN=${RUN:-$(date +%s)$RANDOM}
VERBOSE=${VERBOSE:-0}
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT
pass=0
fail=0

if [ -t 1 ]; then G=$'\e[32m' R=$'\e[31m' D=$'\e[2m' N=$'\e[0m'; else G='' R='' D='' N=''; fi

# Request body from a sample file name, a path, or inline JSON.
payload() {
  local d=$1
  if [ -f "$DIR/samples/$d" ]; then d="$DIR/samples/$d"; fi
  if [ -f "$d" ]; then sed "s/__RUN__/$RUN/g" "$d"; else printf '%s' "$d"; fi
}

# send METHOD PATH [TOKEN] [DATA] -> prints the status code, body goes to $BODY
send() {
  local method=$1 path=$2 token=${3:-} data=${4:-}
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method")
  [ -n "$token" ] && args+=(-H "Authorization: Token $token")
  [ -n "$data" ] && args+=(-H 'Content-Type: application/json' --data "$(payload "$data")")
  curl "${args[@]}" "$BASE$path" || echo 000
}

# Python expression over the last response, parsed as `j`.
jget() {
  python3 -c 'import json, sys; j = json.load(open(sys.argv[1])); r = eval(sys.argv[2]); print(r if not isinstance(r, bool) else str(r).lower())' "$BODY" "$1"
}

# check EXPECTED METHOD PATH [TOKEN] [DATA] [PYTHON_ASSERTION]
check() {
  local exp=$1 method=$2 path=$3 token=${4:-} data=${5:-} cond=${6:-}
  local code ok=1 why=""
  code=$(send "$method" "$path" "$token" "$data")
  if [ "$code" != "$exp" ]; then ok=0; why="got $code, want $exp"
  elif [ -n "$cond" ] && [ "$(jget "$cond" 2>&1)" != "true" ]; then ok=0; why="failed: $cond"
  fi
  local label
  label=$(printf '%-6s %-58s %s' "$method" "$path" "${token:+(as $token)}")
  if [ $ok = 1 ]; then
    pass=$((pass + 1)); echo "${G}PASS${N} $code $label"
  else
    fail=$((fail + 1)); echo "${R}FAIL${N} $code $label  ${R}$why${N}"; echo "${D}$(head -c 600 "$BODY")${N}"
  fi
  if [ "$VERBOSE" = 1 ] && [ -s "$BODY" ]; then echo "${D}$(head -c 600 "$BODY")${N}"; fi
  return 0
}

run_tests() {
  echo "Conduit API test against $BASE (run $RUN)"
  local alice="alice$RUN" bob="bob$RUN" A B slug cid

  echo "-- tags"
  check 200 GET /api/tags '' '' "isinstance(j['tags'], list)"

  echo "-- users and auth"
  check 201 POST /api/users '' register-alice.json "j['user']['username'] == '$alice' and j['user']['bio'] is None"
  A=$(jget "j['user']['token']")
  check 422 POST /api/users '' register-alice.json "'body' in j['errors']"   # duplicate
  check 201 POST /api/users '' register-bob.json
  B=$(jget "j['user']['token']")
  check 422 POST /api/users '' '{"user":{"username":"","email":"x@example.com","password":"p"}}'
  check 422 POST /api/users '' '{"user":'                                     # unparsable body
  check 200 POST /api/users/login '' login-alice.json "j['user']['token'] == '$A'"
  check 401 POST /api/users/login '' "{\"user\":{\"email\":\"$alice@example.com\",\"password\":\"wrong\"}}"
  check 200 POST /api/users/login '' '{"user":{"email":"user1@example.com","password":"password123"}}' \
    "j['user']['username'] == 'user1'"
  check 200 GET /api/user "$A" '' "j['user']['email'] == '$alice@example.com'"
  check 401 GET /api/user
  check 401 GET /api/user notanid
  check 200 PUT /api/user "$A" update-user.json "j['user']['bio'].startswith('I write about Bun')"
  check 422 PUT /api/user "$A" "{\"user\":{\"username\":\"$bob\"}}"            # username taken

  echo "-- profiles"
  check 200 GET "/api/profiles/$bob" '' '' "j['profile']['following'] == False"
  check 404 GET /api/profiles/nobody-$RUN
  check 200 POST "/api/profiles/$bob/follow" "$A" '' "j['profile']['following'] == True"
  check 200 GET "/api/profiles/$bob" "$A" '' "j['profile']['following'] == True"
  check 401 POST "/api/profiles/$bob/follow"

  echo "-- articles"
  check 201 POST /api/articles "$B" create-article.json \
    "j['article']['tagList'] == ['dragons', 'howto', 'training'] and j['article']['author']['username'] == '$bob'"
  slug=$(jget "j['article']['slug']")
  check 401 POST /api/articles '' create-article.json
  check 422 POST /api/articles "$B" '{"article":{"title":"","description":"d","body":"b"}}'
  check 200 GET /api/articles '' '' "len(j['articles']) == 20 and 'body' not in j['articles'][0]"
  check 200 GET "/api/articles?limit=5&offset=10" '' '' "len(j['articles']) == 5"
  check 422 GET "/api/articles?limit=0"
  check 422 GET "/api/articles?offset=-1"
  check 200 GET "/api/articles?author=$bob" '' '' "j['articlesCount'] == 1 and j['articles'][0]['slug'] == '$slug'"
  check 200 GET "/api/articles?tag=dragons" "$A" '' "any(a['slug'] == '$slug' for a in j['articles'])"
  check 200 GET "/api/articles/feed" "$A" '' "j['articles'][0]['slug'] == '$slug' and j['articles'][0]['author']['following']"
  check 401 GET /api/articles/feed
  check 200 GET "/api/articles/$slug" '' '' "j['article']['body'].startswith('You have to believe')"
  check 404 GET "/api/articles/no-such-article-$RUN"
  check 403 PUT "/api/articles/$slug" "$A" update-article.json
  check 200 PUT "/api/articles/$slug" "$B" update-article.json \
    "j['article']['title'].startswith('Did You Train') and j['article']['description'] == 'Ever wonder how?'"
  slug=$(jget "j['article']['slug']")

  echo "-- favorites"
  check 200 POST "/api/articles/$slug/favorite" "$A" '' "j['article']['favorited'] and j['article']['favoritesCount'] == 1"
  check 200 GET "/api/articles?favorited=$alice" '' '' "j['articlesCount'] == 1"
  check 200 DELETE "/api/articles/$slug/favorite" "$A" '' "not j['article']['favorited'] and j['article']['favoritesCount'] == 0"
  check 404 POST "/api/articles/no-such-article-$RUN/favorite" "$A"

  echo "-- comments"
  check 201 POST "/api/articles/$slug/comments" "$A" create-comment.json \
    "j['comment']['body'].startswith('Thank you') and j['comment']['author']['following'] == False"
  cid=$(jget "j['comment']['id']")
  check 422 POST "/api/articles/$slug/comments" "$A" '{"comment":{"body":""}}'
  check 200 GET "/api/articles/$slug/comments" '' '' "j['comments'][0]['id'] == $cid"
  check 403 DELETE "/api/articles/$slug/comments/$cid" "$B"
  check 204 DELETE "/api/articles/$slug/comments/$cid" "$A"
  check 404 DELETE "/api/articles/$slug/comments/$cid" "$A"
  check 404 DELETE "/api/articles/$slug/comments/abc" "$A"

  echo "-- cleanup"
  check 200 DELETE "/api/profiles/$bob/follow" "$A" '' "j['profile']['following'] == False"
  check 403 DELETE "/api/articles/$slug" "$A"
  check 204 DELETE "/api/articles/$slug" "$B"
  check 404 GET "/api/articles/$slug"
  check 200 GET /api/tags '' '' "'dragons' in j['tags']"

  echo
  if [ $fail = 0 ]; then echo "${G}All $pass checks passed${N}"; else echo "${R}$fail failed${N}, $pass passed"; fi
  [ $fail = 0 ]
}

case "${1:-test}" in
  test) run_tests ;;
  call)
    shift
    [ $# -ge 2 ] || { echo "usage: $0 call METHOD PATH [TOKEN] [SAMPLE|JSON]" >&2; exit 2; }
    code=$(send "$@")
    echo "HTTP $code" >&2
    if [ -s "$BODY" ]; then python3 -m json.tool "$BODY" 2>/dev/null || cat "$BODY"; fi
    ;;
  -h|--help|help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) echo "unknown command: $1 (try: test, call, help)" >&2; exit 2 ;;
esac
