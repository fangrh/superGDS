"""Detect whether the installed gdsfactory is the fork with provenance support."""
import sys

def detect():
    try:
        import gdsfactory as gf
    except ImportError:
        print("FORK=none")
        return

    # Check for provenance_inject module (fork-only feature)
    has_provenance_inject = False
    try:
        from gdsfactory import provenance_inject  # noqa: F401
        has_provenance_inject = True
    except ImportError:
        pass

    # Check for the post_process hook on Component
    has_store_hook = callable(getattr(gf.Component, 'store_provenance_on_cell', None))

    # Check for provenance module (sidecar mode)
    has_provenance_module = False
    try:
        from gdsfactory import provenance  # noqa: F401
        has_provenance_module = True
    except ImportError:
        pass

    if has_provenance_inject or has_store_hook or has_provenance_module:
        print("FORK=fork")
    else:
        print("FORK=upstream")


if __name__ == "__main__":
    detect()
