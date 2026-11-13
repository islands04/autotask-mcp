#!/usr/bin/env node

/**
 * Simple mapping test - verify that specific company IDs resolve to names
 */

console.log('🔍 Testing ID-to-Name Mapping...\n');

// Test specific company IDs that were showing as "Customer 624" etc.
const testCompanyIds = [624, 709, 704];

async function testMapping() {
  console.log('🔍 Testing ID-to-Name Mapping...\n');
  
  try {
    // Import modules from dist directory
    const { AutotaskService } = await import('../dist/services/autotask.service.js');
    const { MappingService } = await import('../dist/utils/mapping.service.js');
    const { Logger } = await import('../dist/utils/logger.js');
    const { loadEnvironmentConfig, mergeWithMcpConfig } = await import('../dist/utils/config.js');

    console.log('📊 Loading configuration...');
    const envConfig = loadEnvironmentConfig();
    const mcpConfig = mergeWithMcpConfig(envConfig);
    
    const logger = new Logger('info', 'json');
    const autotaskService = new AutotaskService(mcpConfig, logger);
    const mappingService = new MappingService(autotaskService, logger);

    console.log('🔄 Testing specific company ID mappings...\n');
    
    for (const companyId of testCompanyIds) {
      console.log(`Testing Company ID ${companyId}:`);
      
      try {
        const result = await mappingService.getCompanyName(companyId);
        
        if (result.found) {
          console.log(`  ✅ SUCCESS: "${result.name}"`);
        } else {
          console.log(`  ❌ NOT FOUND: ${result.name}`);
        }
      } catch (error) {
        console.log(`  💥 ERROR: ${error.message}`);
      }
      console.log('');
    }

    // Test cache stats
    console.log('📈 Cache Statistics:');
    const stats = mappingService.getCacheStats();
    console.log(`  Companies cached: ${stats.companies.count}`);
    console.log(`  Resources cached: ${stats.resources.count}`);
    console.log(`  Companies cache valid: ${stats.companies.isValid}`);
    console.log(`  Resources cache valid: ${stats.resources.isValid}`);
    
  } catch (error) {
    console.error('💥 Test failed:', error);
    process.exit(1);
  }
}

testMapping()
  .then(() => {
    console.log('\n✅ Mapping test completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Mapping test failed:', error);
    process.exit(1);
  }); 