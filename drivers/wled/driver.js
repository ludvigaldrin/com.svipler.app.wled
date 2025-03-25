'use strict';

const Homey = require('homey');
const axios = require('axios');

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

      // Process existing discovery results
      const currentResults = this.discoveryStrategy.getDiscoveryResults();
      const resultIds = Object.keys(currentResults);
      this.log('Initial discovery results:', resultIds.length);
      
      if (resultIds.length > 0) {
        // Log detailed information about each discovery result
        for (const id of resultIds) {
          const result = currentResults[id];
          this.log(`Discovery result: ID=${id}, Address=${result.address}, Name=${result.name || 'unnamed'}`);
          this.onDiscoveryResult(result);
        }
      } else {
        this.log('No initial discovery results found');
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
    // Store results for pairing
    const id = discoveryResult.id;
    this.log(`Discovery result received: ID=${id}, Address=${discoveryResult.address || 'unknown'}`);
    
    if (!discoveryResult.address) {
      this.log('Skipping discovery result without address');
      return;
    }
    
    // Check if this is a new discovery or an update
    const isNew = !this.discoveryResults[id];
    this.discoveryResults[id] = discoveryResult;
    
    if (isNew) {
      this.log(`New WLED device discovered: ${discoveryResult.address}`);
    } else {
      this.log(`Updated discovery for WLED device: ${discoveryResult.address}`);
    }
    
    // Log the current count of discovered devices
    this.log(`Total discovered devices: ${Object.keys(this.discoveryResults).length}`);
  }

  // Called when a discovery result is added
  onDiscoveryAvailable(discoveryResult) {
    // Store discovery result
  }

  // Called when a discovery result address changes
  onDiscoveryAddressChanged(discoveryResult) {
    const id = discoveryResult.id;
    this.discoveryResults[id] = discoveryResult;
  }

  // Called when a discovery result's last seen timestamp changes
  onDiscoveryLastSeenChanged(discoveryResult) {
    // Update timestamp
  }
  
  // Helper method to get device info from API
  async getDeviceInfo(ip) {
    try {
      // Create HTTP client for this IP
      const apiClient = axios.create({
        baseURL: `http://${ip}`,
        timeout: 5000
      });
      
      // Get device info from WLED API
      const response = await apiClient.get('/json/info');
      const info = response.data;
      
      // Extract useful information from the API response
      
      // Use the custom name if it exists, or generate a friendly name based on host/mac
      let deviceName = 'WLED';
      if (info.name && info.name !== 'WLED') {
        // Use custom name if it's been changed from default
        deviceName = info.name;
      } else if (info.host) {
        // Use hostname if available
        deviceName = info.host;
      } else if (info.mac) {
        // Use a friendly name based on MAC address
        const shortMac = info.mac.substring(info.mac.length - 6);
        deviceName = `WLED-${shortMac}`;
      }
      
      // Get MAC address for a reliable ID
      const mac = info.mac ? info.mac.replace(/:/g, '') : '';
      
      // Create a unique ID - use MAC if available, otherwise fallback to IP-based ID
      const deviceId = mac ? `wled-${mac.toLowerCase()}` : `wled-${ip.replace(/\./g, '-')}`;
      
      // Create the device data
      const deviceData = {
        name: deviceName,
        data: {
          id: deviceId
        },
        settings: {
          address: ip,     // Keep original 'address' property for backwards compatibility
          ip: ip,          // Add 'ip' property for new code
          pollInterval: 5, // Keep original 'pollInterval' property
          polling_interval: 5000, // Add new property with value in milliseconds
          // Store additional info from the API for reference
          version: info.ver || '',
          fxcount: info.fxcount || 0,
          palcount: info.palcount || 0,
          ledCount: info.leds?.count || 0
        }
      };
      
      return deviceData;
    } catch (error) {
      this.error(`Error getting device info: ${error.message}`);
      throw new Error(`Could not connect to WLED device: ${error.message}`);
    }
  }

  async onPair(session) {
    // Track view state
    let activeView = '';
    let pairingDevice = null;

    // View navigation handler
    session.setHandler('showView', async (view) => {
      activeView = view;
      this.log(`Pairing: navigated to view ${view}`);
      
      // Reset device state on certain view changes
      if (view === 'start') {
        this.log('Resetting pairing device state');
        pairingDevice = null;
      }
      
      // Reset discovery results when returning to discovery page
      if (view === 'discover_devices') {
        this.log('View changed to discover_devices - refreshing discovery results');
        // Force refresh discovery results when view is shown again
        try {
          const currentResults = this.discoveryStrategy.getDiscoveryResults();
          const resultIds = Object.keys(currentResults);
          this.log(`Discovery view refreshed: Found ${resultIds.length} devices`);
          
          // Process each discovery result again
          for (const id of resultIds) {
            const result = currentResults[id];
            this.onDiscoveryResult(result);
          }
        } catch (error) {
          this.error('Error refreshing discovery results:', error);
        }
      }
      
      // Entering the manual entry page
      if (view === 'manual_entry') {
        this.log('Entering manual entry page');
        // UI reset is handled by the page itself
      }
    });

    // Handler for complete discovery strategy refresh
    session.setHandler('refresh_discovery_strategy', async () => {
      this.log('Received request to refresh discovery strategy');
      
      try {
        // Clear existing discovery results first
        this.discoveryResults = {};
        this.log('Cleared existing discovery results');
        
        // Get fresh discovery results
        const currentResults = this.discoveryStrategy.getDiscoveryResults();
        const resultIds = Object.keys(currentResults);
        this.log(`Fresh discovery strategy refresh: Found ${resultIds.length} devices`);
        
        // Process each discovery result
        for (const id of resultIds) {
          const result = currentResults[id];
          this.onDiscoveryResult(result);
        }
        
        // Return success
        return true;
      } catch (error) {
        this.error('Error during full discovery strategy refresh:', error);
        return false;
      }
    });

    // Log handler for debugging
    session.setHandler('log', async (message) => {
      this.log(`WebView: ${message}`);
    });

    // Test connection handler - new improved version
    session.setHandler('test_connection', async (data) => {
      try {
        const address = data.address;
        this.log(`Testing connection to WLED device at: ${address}`);
        
        // Create HTTP client for this test
        const apiClient = axios.create({
          baseURL: `http://${address}`,
          timeout: 5000
        });
        
        // Try to connect to the device
        const response = await apiClient.get('/json/info');
        
        if (response.data) {
          // Get full device data
          const deviceData = await this.getDeviceInfo(address);
          
          this.log(`Successfully connected to WLED device: ${deviceData.name}`);
          
          // Return success with the device data
          return {
            success: true,
            deviceData: deviceData
          };
        } else {
          throw new Error('Received empty response from device');
        }
      } catch (error) {
        this.error(`Connection test failed: ${error.message}`);
        return {
          success: false,
          message: error.message || 'Failed to connect to the device'
        };
      }
    });

    // Store the selected device for pairing
    session.setHandler('selected_device', async (device) => {
      this.log('Device selected for pairing:', device.name, device.data.id);
      pairingDevice = device;
      return true;
    });

    // Get the pairing device on the add_device page
    session.setHandler('get_pairing_device', async () => {
      if (pairingDevice) {
        this.log('Returning device for pairing:', pairingDevice.name);
        return pairingDevice;
      }
      
      this.error('No device selected for pairing');
      return null;
    });

    // Handler for discover_devices view to list discovered devices 
    session.setHandler('list_devices', async () => {
      // Always force a refresh of discovery results when list_devices is called
      this.log('list_devices called - forcing refresh of discovery results');
      
      try {
        // Get fresh discovery results
        const currentResults = this.discoveryStrategy.getDiscoveryResults();
        const resultIds = Object.keys(currentResults);
        this.log(`Refreshed discovery results: Found ${resultIds.length} devices`);
        
        // Process each discovery result again to ensure fresh data
        for (const id of resultIds) {
          const result = currentResults[id];
          this.onDiscoveryResult(result);
        }
      } catch (error) {
        this.error('Error refreshing discovery results:', error);
      }
      
      // Get current discovered devices
      const discoveryResults = Object.values(this.discoveryResults || {});
      this.log(`Found ${discoveryResults.length} discovered devices for pairing`);
      
      if (discoveryResults.length === 0) {
        this.log('No discovery results found');
      } else {
        discoveryResults.forEach((result, index) => {
          this.log(`Discovery result ${index+1}/${discoveryResults.length}: ID=${result.id}, Address=${result.address || 'unknown'}`);
        });
      }
      
      const devices = [];
      
      // Process each discovery result
      for (const discoveryResult of discoveryResults) {
        if (discoveryResult && discoveryResult.address) {
          try {
            this.log(`Processing discovery result for ${discoveryResult.address}`);
            const deviceInfo = await this.getDeviceInfo(discoveryResult.address);
            this.log(`Found device: ${deviceInfo.name} at ${deviceInfo.settings.address}`);
            devices.push(deviceInfo);
          } catch (error) {
            // Skip devices with errors
            this.error(`Error getting info for ${discoveryResult.address}: ${error.message}`);
          }
        }
      }
      
      this.log(`Returning ${devices.length} devices for pairing`);
      if (devices.length > 0) {
        devices.forEach((device, index) => {
          this.log(`Device ${index+1}/${devices.length}: ${device.name} (${device.data.id})`);
        });
      }
      
      return devices;
    });
  }
}

module.exports = WLEDDriver;