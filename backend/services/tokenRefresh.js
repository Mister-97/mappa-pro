const cron = require('node-cron');
const supabase = require('../config/supabase');
const { refreshToken } = require('./fanvueApi');

/**
 * Every hour, find tokens expiring within 2 hours and proactively refresh them.
 * This ensures no user ever hits an expired token mid-session.
 */
function startTokenRefreshJob() {
  cron.schedule('0 * * * *', async () => {
    console.log('[TokenRefresh] Running scheduled token refresh check...');
    
    try {
      const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      
      const { data: accounts, error } = await supabase
        .from('connected_accounts')
        .select('*')
        .eq('is_active', true)
        .lt('token_expires_at', twoHoursFromNow);
      
      if (error) {
        console.error('[TokenRefresh] DB query error:', error);
        return;
      }
      
      if (!accounts || accounts.length === 0) {
        console.log('[TokenRefresh] No tokens need refreshing.');
        return;
      }
      
      console.log(`[TokenRefresh] Refreshing ${accounts.length} token(s)...`);
      
      const results = await Promise.allSettled(
        accounts.map(account => refreshToken(account))
      );
      
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      
      console.log(`[TokenRefresh] Done. Success: ${succeeded}, Failed: ${failed}`);
    } catch (err) {
      console.error('[TokenRefresh] Unexpected error:', err.message);
    }
  });
  
  console.log('[TokenRefresh] Scheduled token refresh job started (runs every hour)');
}

module.exports = { startTokenRefreshJob };
