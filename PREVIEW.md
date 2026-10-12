Local preview uses the actual static application (no build step).

The current preview server runs at http://127.0.0.1:8877/.
Open China directly: http://127.0.0.1:8877/?scenario=china&pane=scenario

In VS Code, run **Open Integrated Browser** from the Command Palette and paste
that China URL. The URL selects China and opens its scenario pane automatically.

To restart the preview later, run the **Preview visualization** workspace task,
or run `python3 -m http.server 8877 --bind 127.0.0.1` from this folder.
Stop the existing server before restarting on the same port.
The existing application loads its libraries, geographic boundaries, and published
scenario spreadsheet over the internet.
