#!/usr/bin/env python3
"""
One-time setup script to authenticate your Telegram user account
Run this once to create the session file, then the news monitor will work
"""
import os
import sys
import asyncio
from telethon import TelegramClient

SESSION_NAME = 'news_monitor_session'

async def setup():
    """Create authenticated session"""
    # Get credentials from environment
    api_id = os.getenv('TELEGRAM_API_ID')
    api_hash = os.getenv('TELEGRAM_API_HASH')
    phone = os.getenv('PHONE_NUMBER', '+14255349021')
    
    if not api_id or not api_hash:
        print("❌ Error: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment")
        sys.exit(1)
    
    try:
        api_id = int(api_id)
    except ValueError:
        print("❌ Error: TELEGRAM_API_ID must be a number")
        sys.exit(1)
    
    print("=" * 60)
    print("Telegram User Authentication Setup")
    print("=" * 60)
    print(f"API ID: {api_id}")
    print(f"Phone: {phone}")
    print()
    
    print("🔄 Connecting to Telegram...")
    client = TelegramClient(SESSION_NAME, api_id, api_hash)
    
    print("📱 Telegram will send a code to your phone...")
    await client.start(phone=phone)
    
    me = await client.get_me()
    print()
    print("=" * 60)
    print(f"✅ Successfully authenticated!")
    print("=" * 60)
    print(f"Name: {me.first_name} {me.last_name or ''}")
    if me.username:
        print(f"Username: @{me.username}")
    print(f"Phone: {me.phone}")
    print(f"Session file: {SESSION_NAME}.session")
    print()
    print("✅ Setup complete! The news monitor can now read messages from")
    print("   the IFTTT bot and forward them to your channel.")
    print()
    print("Next: Remove TELEGRAM_BOT_TOKEN from the news monitor environment")
    print("      so it uses this user session instead.")
    
    await client.disconnect()

if __name__ == '__main__':
    try:
        asyncio.run(setup())
    except KeyboardInterrupt:
        print("\n❌ Setup cancelled by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
