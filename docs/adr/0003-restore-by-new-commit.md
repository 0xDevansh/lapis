# Restore By New Commit

Restoring a vault or individual file to an older version creates a new current commit whose contents match the selected historical version, rather than moving the web vault head backward. This preserves an append-only timeline for connected local vaults, keeps rollback visible in history, and makes restore operations sync like ordinary changes.
