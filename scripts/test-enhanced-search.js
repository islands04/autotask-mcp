// Test Enhanced Ticket Search
// This script tests whether the enhanced tool handler properly maps company IDs to names

async function testEnhancedTicketSearch() {
  console.log('🎯 Testing Enhanced Ticket Search...\n');
  
  try {
    // Import modules from dist directory
    const { AutotaskService } = await import('../dist/services/autotask.service.js');
    const { EnhancedAutotaskToolHandler } = await import('../dist/handlers/enhanced.tool.handler.js');
    const { Logger } = await import('../dist/utils/logger.js');
    const { loadEnvironmentConfig, mergeWithMcpConfig } = await import('../dist/utils/config.js');

    console.log('📊 Loading configuration...');
    const envConfig = loadEnvironmentConfig();
    const mcpConfig = mergeWithMcpConfig(envConfig);
    
    const logger = new Logger('info', 'simple');
    const autotaskService = new AutotaskService(mcpConfig, logger);
    const enhancedHandler = new EnhancedAutotaskToolHandler(autotaskService, logger);
    
    console.log('🔍 Searching for open tickets with enhanced mapping...');
    
    // Search for open tickets
    const result = await enhancedHandler.callTool('search_tickets', {
      pageSize: 5, // Just get a few for testing
      status: 1 // Open tickets
    });
    
    if (result.isError) {
      console.error('❌ Search failed:', result.content[0]?.text);
      return;
    }
    
    const data = JSON.parse(result.content[0].text);
    console.log('\n📋 Enhanced Search Results:');
    console.log(`Total tickets found: ${data.data?.items?.length || 'unknown'}`);
    
    if (data.data?.items?.length > 0) {
      console.log('\n🔍 Sample tickets with enhancement data:');
      
      data.data.items.slice(0, 3).forEach((ticket, index) => {
        console.log(`\n--- Ticket ${index + 1} ---`);
        console.log(`ID: ${ticket.id}`);
        console.log(`Title: ${ticket.title}`);
        console.log(`Company ID: ${ticket.companyID}`);
        
        if (ticket._enhanced) {
          console.log(`✅ ENHANCED - Company Name: ${ticket._enhanced.companyName || 'Not found'}`);
          if (ticket._enhanced.assignedResourceName) {
            console.log(`✅ ENHANCED - Assigned To: ${ticket._enhanced.assignedResourceName}`);
          }
        } else {
          console.log('❌ NO ENHANCEMENT DATA FOUND');
        }
      });
    }
    
    console.log('\n📈 Testing mapping cache status...');
    const cacheResult = await enhancedHandler.callTool('get_mapping_cache_stats', {});
    if (!cacheResult.isError) {
      const cacheData = JSON.parse(cacheResult.content[0].text);
      console.log('Cache stats:', cacheData.data);
    }
    
  } catch (error) {
    console.error('💥 Test failed:', error.message);
    console.error(error);
  }
}

testEnhancedTicketSearch()
  .then(() => {
    console.log('\n✅ Enhanced search test completed!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n💥 Test failed:', error);
    process.exit(1);
  }); 