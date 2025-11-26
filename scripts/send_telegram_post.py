#!/usr/bin/env python3
"""
Generic Telegram post sender for referral/explainer/news posts.

Environment variables required:
  - TELEGRAM_API_ID: your Telegram API ID (integer)
  - TELEGRAM_API_HASH: your Telegram API hash (string)
  - TELEGRAM_BOT_TOKEN: bot token from @BotFather (string)

Usage:
  python3 scripts/send_telegram_post.py \
    --group "-1002746332286" \
    --caption "Your message here" \
    --image "/path/to/image.png"

  python3 scripts/send_telegram_post.py \
    --group "-1002746332286" \
    --caption "Your message here" \
    --video "/path/to/video.mp4"
"""

import argparse
import os
import sys
from typing import Optional

from telethon import TelegramClient


CAPTION_MAX_CHARS = 1024


def read_env_var(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"ERROR: Missing required environment variable: {name}", file=sys.stderr)
        sys.exit(1)
    return value


def escape_html(text: str) -> str:
    """Escape HTML special characters for Telegram."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


async def async_main(args: argparse.Namespace) -> None:
    api_id = int(read_env_var("TELEGRAM_API_ID"))
    api_hash = read_env_var("TELEGRAM_API_HASH")
    bot_token = read_env_var("TELEGRAM_BOT_TOKEN")

    # Determine which media file to use
    media_path: Optional[str] = None
    if args.image:
        media_path = args.image
    elif args.video:
        media_path = args.video
    
    # Verify media file exists if provided
    if media_path and not os.path.isfile(media_path):
        print(f"ERROR: Media file not found at: {media_path}", file=sys.stderr)
        sys.exit(3)

    # Prepare caption
    caption = args.caption.strip() if args.caption else ""
    if args.escape_html:
        caption = escape_html(caption)
    
    if len(caption) > CAPTION_MAX_CHARS:
        caption = caption[:CAPTION_MAX_CHARS - 4].rstrip() + " ..."

    if args.dry_run:
        print("--- DRY RUN ---")
        print(f"Target: {args.group}")
        print(f"Media: {media_path or 'None'}")
        print(f"Caption:\n{caption}")
        return

    # Connect to Telegram
    client = TelegramClient("telegram-poster-bot", api_id, api_hash)
    await client.start(bot_token=bot_token)

    # Resolve target entity
    target_raw = args.group
    try:
        target = int(target_raw) if target_raw.lstrip("-").isdigit() else target_raw
        entity = await client.get_entity(target)
    except Exception as e:
        print(f"ERROR: Failed to resolve group/channel '{args.group}': {e}", file=sys.stderr)
        await client.disconnect()
        sys.exit(4)

    # Send message
    try:
        if media_path:
            # Send with media (image or video)
            message = await client.send_file(
                entity=entity,
                file=media_path,
                caption=caption if caption else None,
                supports_streaming=True if args.video else None,
                parse_mode=None,  # plain text
            )
        else:
            # Send text-only message
            message = await client.send_message(
                entity=entity,
                message=caption,
                parse_mode=None,
            )
        
        print(f"Posted to {args.group}; message id: {getattr(message, 'id', 'unknown')}")
    except Exception as e:
        print(f"ERROR: Failed to send post: {e}", file=sys.stderr)
        await client.disconnect()
        sys.exit(5)

    await client.disconnect()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send a Telegram post (text, image, or video) to a group/channel."
    )
    parser.add_argument(
        "--group",
        required=True,
        help="Target @username, t.me link, or numeric ID (e.g., -1002746332286)",
    )
    parser.add_argument(
        "--caption",
        default="",
        help="Caption or message text",
    )
    parser.add_argument(
        "--image",
        help="Path to image file (PNG, JPG, etc.)",
    )
    parser.add_argument(
        "--video",
        help="Path to video file (MP4, etc.)",
    )
    parser.add_argument(
        "--escape-html",
        action="store_true",
        help="Escape HTML special characters in caption",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print details and exit without sending",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    
    # Validate: must have either image or video if media is intended
    if not args.image and not args.video and not args.caption:
        print("ERROR: Must provide at least --caption, --image, or --video", file=sys.stderr)
        sys.exit(2)
    
    import asyncio
    try:
        asyncio.run(async_main(args))
    except KeyboardInterrupt:
        print("Cancelled by user")


if __name__ == "__main__":
    main()
