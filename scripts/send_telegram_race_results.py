#!/usr/bin/env python3
"""
Send a Telegram video (tgmsg.mp4) with a caption built from text or JSON.

Environment variables required:
  - TELEGRAM_API_ID: your Telegram API ID (integer)
  - TELEGRAM_API_HASH: your Telegram API hash (string)
  - TELEGRAM_BOT_TOKEN: bot token from @BotFather (string)

Usage examples:
  # Using example JSON to build the caption
  python3 scripts/send_telegram_race_results.py \
    --group "@your_group_or_channel" \
    --json "/workspace/scripts/race_results_example.json"

  # Using a direct caption
  python3 scripts/send_telegram_race_results.py \
    --group "-1001234567890" \
    --caption "Race 7 Winner: #5 Thunderbolt in 1:09.85 (3.5-1)"

Video default path: /workspace/tgmsg.mp4 (pass --video to override)
"""

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

from telethon import TelegramClient


CAPTION_MAX_CHARS = 1024  # Telegram caption hard limit for most clients/bots


def read_env_var(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"ERROR: Missing required environment variable: {name}")
        sys.exit(1)
    return value


def format_money(value: Any) -> Optional[str]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return f"${number:,.2f}"


def build_caption_from_json(json_path: str) -> str:
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    lines: List[str] = []

    race_name = data.get("race_name") or data.get("name") or data.get("title")
    if race_name:
        lines.append(str(race_name))

    date_value = data.get("date") or data.get("datetime") or data.get("timestamp")
    distance = data.get("distance")
    surface = data.get("surface")
    track = data.get("track") or data.get("venue")

    meta_parts: List[str] = []
    if date_value:
        meta_parts.append(f"Date: {date_value}")
    if track:
        meta_parts.append(f"Track: {track}")
    dist_surf: List[str] = []
    if distance:
        dist_surf.append(str(distance))
    if surface:
        dist_surf.append(str(surface))
    if dist_surf:
        meta_parts.append(f"Distance/Surface: {' '.join(dist_surf)}")
    if meta_parts:
        lines.append(" | ".join(meta_parts))

    winner = data.get("winner") or {}
    winner_name = None
    winner_number = None
    winner_odds = None
    winner_time = None
    if isinstance(winner, dict):
        winner_name = winner.get("name")
        winner_number = winner.get("number") or winner.get("no") or winner.get("post")
        winner_odds = winner.get("odds")
        winner_time = winner.get("time") or winner.get("final_time")

    overall_time = data.get("time") or data.get("final_time")
    odds = data.get("odds")

    time_to_show = winner_time or overall_time
    odds_to_show = winner_odds or odds

    if winner_name or winner_number or time_to_show or odds_to_show:
        winner_bits: List[str] = []
        if winner_number is not None and winner_name:
            winner_bits.append(f"Winner: #{winner_number} {winner_name}")
        elif winner_name:
            winner_bits.append(f"Winner: {winner_name}")
        elif winner_number is not None:
            winner_bits.append(f"Winner: #{winner_number}")
        if time_to_show:
            winner_bits.append(f"Time: {time_to_show}")
        if odds_to_show:
            winner_bits.append(f"Odds: {odds_to_show}")
        if winner_bits:
            lines.append("  ".join(winner_bits))

    jockey = (winner.get("jockey") if isinstance(winner, dict) else None) or data.get("jockey")
    trainer = (winner.get("trainer") if isinstance(winner, dict) else None) or data.get("trainer")
    owner = (winner.get("owner") if isinstance(winner, dict) else None) or data.get("owner")
    details_bits: List[str] = []
    if jockey:
        details_bits.append(f"Jockey: {jockey}")
    if trainer:
        details_bits.append(f"Trainer: {trainer}")
    if owner:
        details_bits.append(f"Owner: {owner}")
    if details_bits:
        lines.append("  ".join(details_bits))

    payouts = data.get("payouts") or {}
    if isinstance(payouts, dict) and payouts:
        win_str = format_money(payouts.get("win"))
        place_str = format_money(payouts.get("place"))
        show_str = format_money(payouts.get("show"))
        payout_bits: List[str] = []
        if win_str:
            payout_bits.append(f"W {win_str}")
        if place_str:
            payout_bits.append(f"P {place_str}")
        if show_str:
            payout_bits.append(f"S {show_str}")
        if payout_bits:
            lines.append(f"Payouts: {', '.join(payout_bits)}")

    results = data.get("results") or data.get("order") or data.get("finishers")
    if isinstance(results, list) and results:
        lines.append("Results:")
        for item in results:
            try:
                pos = item.get("position") or item.get("pos") or item.get("rank")
                num = item.get("number") or item.get("no") or item.get("post")
                name = item.get("name")
                i_odds = item.get("odds")
            except AttributeError:
                continue
            parts: List[str] = []
            if pos is not None:
                parts.append(f"{pos})")
            if num is not None:
                parts.append(f"#{num}")
            if name:
                parts.append(str(name))
            if i_odds:
                parts.append(f"({i_odds})")
            if parts:
                lines.append(" ".join(parts))

    notes = data.get("notes")
    if notes:
        lines.append(f"Notes: {notes}")

    caption = "\n".join(lines).strip()
    if len(caption) > CAPTION_MAX_CHARS:
        caption = caption[: CAPTION_MAX_CHARS - 4].rstrip() + " ..."
    return caption


def resolve_caption(caption_text: Optional[str], json_path: Optional[str]) -> str:
    built: List[str] = []
    if caption_text:
        built.append(caption_text.strip())
    if json_path:
        built.append(build_caption_from_json(json_path))
    final = "\n\n".join([b for b in built if b]).strip()
    if not final:
        print("ERROR: You must provide --caption or --json")
        sys.exit(2)
    if len(final) > CAPTION_MAX_CHARS:
        final = final[: CAPTION_MAX_CHARS - 4].rstrip() + " ..."
    return final


async def async_main(args: argparse.Namespace) -> None:
    api_id = int(read_env_var("TELEGRAM_API_ID"))
    api_hash = read_env_var("TELEGRAM_API_HASH")
    bot_token = read_env_var("TELEGRAM_BOT_TOKEN")

    video_path = args.video
    if not os.path.isfile(video_path):
        print(f"ERROR: Video not found at: {video_path}")
        sys.exit(3)

    caption = resolve_caption(args.caption, args.json_path)
    if args.dry_run:
        print("--- DRY RUN ---")
        print(caption)
        return

    # Use MemorySession to avoid SQLite database locks when running multiple instances
    from telethon.sessions import MemorySession
    client = TelegramClient(MemorySession(), api_id, api_hash)
    await client.start(bot_token=bot_token)

    target_raw = args.group
    try:
        target = int(target_raw) if target_raw.lstrip("-").isdigit() else target_raw
        entity = await client.get_entity(target)
    except Exception as e:
        print(f"ERROR: Failed to resolve group/channel '{args.group}': {e}")
        await client.disconnect()
        sys.exit(4)

    try:
        message = await client.send_file(
            entity=entity,
            file=video_path,
            caption=caption,
            supports_streaming=True,
            parse_mode=None,  # keep caption as plain text
        )
        print(f"Sent video to {args.group}; message id: {getattr(message, 'id', 'unknown')}")
    except Exception as e:
        print(f"ERROR: Failed to send video: {e}")
        await client.disconnect()
        sys.exit(5)

    await client.disconnect()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Post tgmsg.mp4 with race results caption to a Telegram group/channel via Telethon."
    )
    parser.add_argument(
        "--group",
        required=True,
        help="Target @username, t.me link, or numeric ID (e.g., -1001234567890)",
    )
    parser.add_argument(
        "--video",
        default="/workspace/tgmsg.mp4",
        help="Path to the video file (default: /workspace/tgmsg.mp4)",
    )
    parser.add_argument(
        "--json",
        dest="json_path",
        help="Path to JSON file with race results to compose caption",
    )
    parser.add_argument(
        "--caption",
        help="Direct caption text to attach to the video",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the composed caption and exit without sending",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    # Import asyncio locally to keep top-level imports minimal
    import asyncio

    try:
        asyncio.run(async_main(args))
    except KeyboardInterrupt:
        print("Cancelled by user")


if __name__ == "__main__":
    main()

