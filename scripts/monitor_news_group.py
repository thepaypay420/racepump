#!/usr/bin/env python3
"""
News Group Monitor
Monitors a Telegram news group and forwards headlines to the server
"""
import os
import sys
import asyncio
import logging
from telethon import TelegramClient, events
from telethon.sessions import MemorySession
import aiohttp

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

# Telegram API credentials
API_ID = os.getenv('TELEGRAM_API_ID')
API_HASH = os.getenv('TELEGRAM_API_HASH')
BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN')  # Optional: use bot instead of user account
SESSION_NAME = os.getenv('TELEGRAM_SESSION_NAME', 'news_monitor_session')

# News source group
NEWS_GROUP_ID = int(os.getenv('NEWS_GROUP_ID', '-1002402767536'))

# Server endpoint for posting news
SERVER_URL = os.getenv('SERVER_URL', 'http://localhost:5000/api/admin/post-news')
ADMIN_TOKEN = os.getenv('ADMIN_TOKEN', '')

async def send_to_server(headline: str, url: str = None):
    """Send news headline to server endpoint"""
    try:
        headers = {
            'Authorization': f'Bearer {ADMIN_TOKEN}',
            'Content-Type': 'application/json'
        }
        
        payload = {'headline': headline}
        if url:
            payload['url'] = url
        
        async with aiohttp.ClientSession() as session:
            async with session.post(SERVER_URL, json=payload, headers=headers) as resp:
                if resp.status == 200:
                    logger.info(f'✅ Sent to server: {headline[:60]}...')
                    return True
                else:
                    logger.error(f'❌ Server returned {resp.status}: {await resp.text()}')
                    return False
    except Exception as e:
        logger.error(f'❌ Failed to send to server: {e}')
        return False

async def main():
    """Monitor news group for new messages"""
    if not API_ID or not API_HASH:
        logger.error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set')
        sys.exit(1)
    
    if not ADMIN_TOKEN:
        logger.error('ADMIN_TOKEN must be set')
        sys.exit(1)
    
    logger.info(f'Starting news monitor for group {NEWS_GROUP_ID}')
    logger.info(f'Server endpoint: {SERVER_URL}')
    
    # Create Telegram client - use in-memory session for bots to avoid session conflicts
    if BOT_TOKEN:
        logger.info('Using bot token authentication')
        client = TelegramClient(MemorySession(), API_ID, API_HASH)
        await client.start(bot_token=BOT_TOKEN)
        logger.info('✅ Bot authenticated successfully (in-memory session)')
    else:
        logger.info('Using user session authentication')
        client = TelegramClient(SESSION_NAME, API_ID, API_HASH)
        # Check if we can connect without prompting for credentials
        await client.connect()
        if not await client.is_user_authorized():
            logger.error('Session file not found or invalid')
            logger.error('Please run the authentication script first to create a session')
            logger.error('Or set TELEGRAM_BOT_TOKEN environment variable to use a bot')
            await client.disconnect()
            sys.exit(1)
        logger.info('✅ User session valid, authenticated')
    
    @client.on(events.NewMessage(chats=NEWS_GROUP_ID))
    async def handle_new_message(event):
        """Handle new messages from news group"""
        try:
            message = event.message
            text = message.message or ''
            
            # Skip empty messages
            if not text.strip():
                logger.info('Skipping empty message')
                return
            
            # Extract headline (first line or first 200 chars)
            lines = text.strip().split('\n')
            headline = lines[0] if lines else text
            headline = headline[:200]  # Limit length
            
            # Try to extract URL if present
            url = None
            for entity in (message.entities or []):
                if hasattr(entity, 'url'):
                    url = entity.url
                    break
            
            # Also check for URLs in text
            if not url and ('http://' in text or 'https://' in text):
                words = text.split()
                for word in words:
                    if word.startswith('http://') or word.startswith('https://'):
                        url = word
                        break
            
            logger.info(f'📰 New message in news group: {headline[:60]}...')
            
            # Send to server
            await send_to_server(headline, url)
            
        except Exception as e:
            logger.error(f'Error handling message: {e}')
    
    logger.info('✅ News monitor started, listening for messages...')
    
    # Keep running
    await client.run_until_disconnected()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info('News monitor stopped by user')
    except Exception as e:
        logger.error(f'Fatal error: {e}')
        sys.exit(1)
