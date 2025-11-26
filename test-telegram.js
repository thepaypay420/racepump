// Test script to manually trigger Telegram notification
import('./dist/index.js').then(async () => {
  try {
    // Import the necessary modules
    const { getDb } = await import('./dist/index.js');
    
    // Get the race data
    const storage = getDb();
    const raceId = 'race_1761500024347_0';
    const race = await storage.getRace(raceId);
    
    if (!race) {
      console.error('Race not found:', raceId);
      process.exit(1);
    }
    
    console.log('Found race:', raceId);
    console.log('Winner index:', race.winnerIndex);
    
    // Manually trigger the Telegram event
    const { raceEvents } = await import('./dist/index.js');
    console.log('Emitting race_settled event...');
    raceEvents.emit('race_settled', race);
    
    // Give it time to process
    setTimeout(() => {
      console.log('Test complete');
      process.exit(0);
    }, 5000);
    
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
});
