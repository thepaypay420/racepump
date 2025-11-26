#!/usr/bin/env python3
"""
Telegram Authentication Script
Creates a session file for the news monitor to use
Run this script interactively to authenticate with Telegram
"""
import os
import sys
import asyncio
from telethon import TelegramClient

# Get credentials from environment
API_ID = os.getenv('TELEGRAM_API_ID')
API_HASH = os.getenv('TELEGRAM_API_HASH')
SESSION_NAME = os.getenv('TELEGRAM_SESSION_NAME', 'news_monitor_session')

async def main():
    """Authenticate and create session file"""
    if not API_ID or not API_HASH:
        print('ERROR: TELEGRAM_API_ID and TELEGRAM_API_HASH environment variables must be set')
        sys.exit(1)
    
    print(f'Creating Telegram session: {SESSION_NAME}')
    print('This will prompt you for your phone number and verification code')
    print('---')
    
    # Create client and start interactive authentication
    client = TelegramClient(SESSION_NAME, API_ID, API_HASH)
    
    try:
        await client.start()
        
        # Verify connection by getting account info
        me = await client.get_me()
        print(f'\n✅ Successfully authenticated as {me.first_name} (@{me.username})')
        print(f'✅ Session file created: {SESSION_NAME}.session')
        print('\nThe news monitor can now run in the background using this session')
        
        await client.disconnect()
        
    except Exception as e:
        print(f'\n❌ Authentication failed: {e}')
        sys.exit(1)

if __name__ == '__main__':
    asyncio.run(main())
