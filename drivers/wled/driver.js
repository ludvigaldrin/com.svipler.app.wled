'use strict';

const Homey = require('homey');
const { HttpClient } = require('../../lib/http-client');

class WLEDDriver extends Homey.Driver {
  
  async onInit() {
    this.log('WLED Driver initialized');
    
    // Initialize discovery results storage
    this.discoveryResults = {};
    
    // Get the discovery strategy
    try {
      this.discoveryStrategy = this.getDiscoveryStrategy();
      
      // Listen for new discovery results
      this.discoveryStrategy.on('result', this.onDiscoveryResult.bind(this));
      
      // Process existing discovery results (correctly iterate over object)
      const currentResults = this.discoveryStrategy.getDiscoveryResults();
      for (const discoveryResult of Object.values(currentResults)) {
        this.onDiscoveryResult(discoveryResult);
      }
    } catch (error) {
      this.error('Discovery strategy error:', error);
    }

    this.homey.on('unload', () => {
      this.log('App is unloading, cleaning up discovery listeners');
    });
  }
  
  // Handle device discovery
  onDiscoveryResult(discoveryResult) {
    this.log('Discovery result', JSON.stringify(discoveryResult, null, 2));
    
    // Store results for pairing
    this.discoveryResults[discoveryResult.id] = discoveryResult;
  }
  
  // List discovered and paired devices
  async onPairListDevices({ discovery }) {
    const devices = [];
    
    // If using discovery, get the discovered devices
    if (discovery) {
      const discoveryResults = Object.values(this.discoveryResults || {});
      
      for (const discoveryResult of discoveryResults) {
        if (discoveryResult && discoveryResult.address) {
          const device = {
            name: discoveryResult.name || `WLED (${discoveryResult.address})`,
            data: {
              id: `wled-${discoveryResult.id.replace(/\./g, '-')}`
            },
            settings: {
              address: discoveryResult.address,
              pollInterval: 5
            }
          };
          
          devices.push(device);
        }
      }
    }
    
    return devices;
  }
  
  // Handle manual device pairing
  async onPair(session) {
    // Store the manual device and add more logging
    this.manualDevice = null;
    this.log('Starting pairing process');

    // Get Homey IP to pre-fill the input field
    const homeyIp = await this.getHomeyIp();
    this.log(`Got Homey IP: ${homeyIp}`);
    
    // When a view is shown
    session.setHandler('showView', async (view) => {
      this.log(`Showing view: ${view}`);
      
      // If showing manual entry view, send the suggested IP
      if (view === 'manual_entry' && homeyIp) {
        session.emit('suggested_ip', homeyIp);
      }
    });

    session.setHandler('manual_entry', async ({ ip }) => {
      this.log(`Attempting manual entry with IP: ${ip}`);
      try {
        // Check if the device is a WLED device
        const client = new HttpClient(`http://${ip}`);
        this.log('Created HTTP client, fetching device info...');
        
        const info = await client.get('/json/info');
        this.log(`Got device info:`, info.name);
        
        if (!info || !info.brand || info.brand.toLowerCase() !== 'wled') {
          this.log('Device is not a WLED device');
          return { success: false, message: 'The device at this IP does not appear to be a WLED device.' };
        }
        
        // Create a device object
        const deviceId = `wled-manual-${ip.replace(/\./g, '-')}`;
        const device = {
          name: info.name || `WLED (${ip})`,
          data: {
            id: deviceId
          },
          settings: {
            address: ip,
            pollInterval: 5
          }
        };
        
        // Store the manual device for the add_manually handler
        this.manualDevice = device;
        this.log(`Manual device prepared for pairing:`, this.manualDevice);
        
        return { success: true };
      } catch (error) {
        this.error('Error connecting to WLED device:', error);
        return { success: false, message: `Could not connect to WLED device: ${error.message}` };
      }
    });
    
    session.setHandler('list_devices', async () => {
      this.log('Handler: list_devices called');
      return await this.onPairListDevices({ discovery: true });
    });
    
    session.setHandler('add_manually', async () => {
      this.log('Handler: add_manually called');
      if (this.manualDevice) {
        this.log('Returning manual device for pairing:', this.manualDevice);
        return [this.manualDevice];
      }
      this.log('No manual device available');
      return [];
    });
  }

  // Helper method to get Homey's IP address for suggesting IPs
  async getHomeyIp() {
    try {
      // This will get Homey's network interfaces
      const addresses = this.homey.cloud.getLocalAddress();
      
      if (addresses && addresses.length > 0) {
        // Get the first address and extract the first three octets
        const ipParts = addresses[0].split('.');
        if (ipParts.length === 4) {
          return `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}`;
        }
      }
      return null;
    } catch (error) {
      this.error('Error getting Homey IP:', error);
      return null;
    }
  }
}

module.exports = WLEDDriver; 