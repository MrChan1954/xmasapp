# Summarise a pg_dump --data-only --use-copy file.
#
# WHY THIS IS A FILE AND NOT AN INLINE grep
#   The first two backup runs failed verification on a dump that was perfectly
#   good. The checks were `grep -cE "^COPY public\."`, which assumes pg_dump
#   writes bare identifiers. The Supabase CLI runs pg_dump with
#   --quote-all-identifiers, so the real output is:
#
#       COPY "public"."people" ("id", "name") FROM stdin;
#
#   and the grep matched nothing. A backup containing every row the family has
#   was rejected as empty. Parsing the header properly -- in something that can
#   be run against fixtures by the test suite -- is the fix; another slightly
#   less wrong grep is not.
#
# WHAT IT PRINTS
#   One line of aggregates, and nothing else:
#
#       <blocks> <public_blocks> <rows> <core_count> <core_tables>
#
#   Row CONTENTS are never printed. This runs in GitHub Actions, and the rows
#   are the family's purchases and payments; only counts and table names leave
#   this script.
#
# EXIT
#   Always 0. Judging the numbers is the caller's job, so that the policy about
#   what counts as a valid backup lives in one place in the workflow.

function unquote(identifier) {
  # Postgres quotes an identifier by wrapping it in " and doubling any internal
  # ". Our identifiers are plain lower_snake_case, so stripping the quote
  # characters is sufficient and keeps this readable.
  gsub(/"/, "", identifier)
  return identifier
}

# A COPY header is:  COPY [<schema>.]<table> [(columns)] FROM stdin;
#
# Either identifier may be quoted independently, so all four of these are
# legitimate and all four must be recognised:
#
#   COPY public.people (...)        COPY "public"."people" (...)
#   COPY public."people" (...)      COPY "public".people (...)
#
# Matched on the two ends of the line -- it starts with COPY and finishes with
# FROM stdin; -- rather than on the shape of the identifier in between, which is
# exactly the assumption that broke before.
/^COPY[ \t]/ && /FROM[ \t]+stdin;[ \t]*$/ {
  qualified = $0
  sub(/^COPY[ \t]+/, "", qualified)
  sub(/[ \t]*\(.*$/, "", qualified)                     # drop a column list...
  sub(/[ \t]+FROM[ \t]+stdin;[ \t]*$/, "", qualified)   # ...or FROM directly
  qualified = unquote(qualified)

  schema = ""
  table = qualified
  dot = index(qualified, ".")
  if (dot > 0) {
    schema = substr(qualified, 1, dot - 1)
    table = substr(qualified, dot + 1)
  }

  blocks++
  # An unqualified COPY targets the search_path, which for these dumps is
  # public. Anything explicitly in another schema is not application data.
  if (schema == "" || schema == "public") {
    public_blocks++
    if (table ~ CORE) core[table] = 1
  }

  in_block = 1
  next
}

# pg_dump terminates a COPY block with a line containing exactly \.
in_block && /^\\\.[ \t]*$/ {
  in_block = 0
  next
}

# Everything else inside a block is a row of real data. Counted, never printed.
in_block && NF {
  rows++
}

END {
  core_count = 0
  core_tables = ""
  for (name in core) {
    core_count++
    core_tables = core_tables (core_tables == "" ? "" : ",") name
  }
  printf "%d %d %d %d %s\n",
    blocks + 0,
    public_blocks + 0,
    rows + 0,
    core_count,
    (core_tables == "" ? "-" : core_tables)
}
