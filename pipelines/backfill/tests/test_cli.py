import os
import signal

import pytest

from gerlines_backfill.cli import exit_on_terminate


def test_a_terminate_signal_becomes_an_exit_the_loader_can_record() -> None:
    previous = signal.getsignal(signal.SIGTERM)
    try:
        exit_on_terminate()
        with pytest.raises(SystemExit) as stopped:
            os.kill(os.getpid(), signal.SIGTERM)
        assert stopped.value.code == 128 + signal.SIGTERM
    finally:
        signal.signal(signal.SIGTERM, previous)
