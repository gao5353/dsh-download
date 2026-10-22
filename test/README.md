# Tests that need no network, no Neat Download Manager and no dsh installation.
#
# Only these run in CI, because a green badge has to mean something on a machine that has none of
# the things this plugin is usually used with. Everything they touch is local: a `node:http` server
# standing in for a mirror, or a temporary directory standing in for a dsh home.
#
# The author-side suites (real mirrors, real Neat Download Manager, registry inspection, the dsh
# CLI's own validator) are deliberately not shipped: they depend on a mirror's mood and on software
# the runner does not have, so they would either flake or be skipped, and neither is a signal.
#
#   node test/status-store.mjs   the status registry: states, percentages, bounded history, atomic writes
#   node test/integrity.mjs      a download is never called successful unless every byte is on disk,
#                                the destination is where it was asked for, and the options change
#                                behaviour rather than merely existing
#   node test/resume.mjs         an interrupted transfer continues from the byte it stopped at and
#                                ends byte-identical to the source
#   node test/multisource.mjs    ranges spread across mirrors, and every mirror that does not prove
#                                it serves identical bytes is refused instead of trusted
#   node test/cleanup.mjs        what a stopped transfer leaves behind, and what it must not
#   node test/ui-routes.mjs      the read-only HTTP endpoints: loopback gating, method gating,
#                                dispatch, and that a broken dependency cannot take the host down
#
# Two of them read the machine's real dsh home to assert they left it alone — that is the point of
# those assertions, and they compare before and after rather than assuming a clean machine.
