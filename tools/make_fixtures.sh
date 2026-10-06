#!/bin/sh
# 테스트용 오디오 생성 (ffmpeg 필요)
set -e
cd "$(dirname "$0")/../tests/fixtures"
ffmpeg -v error -y -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=1800" -ac 1 -b:a 128k long.mp3
ffmpeg -v error -y -f lavfi -i "sine=frequency=300:sample_rate=48000:duration=720" -af "volume='if(between(t,356,359),0,1)':eval=frame" -ac 2 -c:a pcm_s16le gap.wav
ffmpeg -v error -y -f lavfi -i "sine=frequency=500:sample_rate=44100:duration=95" -ac 1 -c:a aac -b:a 64k short.m4a
ffmpeg -v error -y -f lavfi -i "sine=frequency=500:sample_rate=44100:duration=200" -ac 1 -b:a 64k -id3v2_version 3 -metadata title="테스트" short.mp3
