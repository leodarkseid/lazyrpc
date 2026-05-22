#!/usr/bin/env bash

find . -type f -name "*.js" | while read -r jsfile; do
    tsfile="${jsfile%.js}.ts"

    if [ -f "$tsfile" ]; then
        echo "Deleting: $jsfile (matched $tsfile)"
        rm "$jsfile"
    fi
done