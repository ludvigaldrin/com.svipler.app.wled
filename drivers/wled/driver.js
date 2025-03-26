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
      this.log(`Initial discovery found ${resultIds.length} devices`);
      
      if (resultIds.length > 0) {
        // Process each discovery result
        for (const id of resultIds) {
          const result = currentResults[id];
          this.onDiscoveryResult(result);
        }
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
    
    if (!discoveryResult.address) {
      return;
    }
    
    // Check if this is a new discovery or an update
    const isNew = !this.discoveryResults[id];
    this.discoveryResults[id] = discoveryResult;
    
    if (isNew) {
      this.log(`New WLED device discovered: ${discoveryResult.address} ${discoveryResult.name}`);
    }
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
    let previousView = '';
    let pairingDevice = null;
    let lastDiscoveryRefresh = 0;
    let manuallyReloadedViews = {};

    // View navigation handler
    session.setHandler('showView', async (view) => {
      
      // Store previous view before updating
      previousView = activeView;
      activeView = view;
      
      // Reset device state on certain view changes
      if (view === 'start') {
        pairingDevice = null;
      }
      
      // Special handling for discover_devices view - only reload once per session
      if (view === 'discover_devices' && previousView !== '' && previousView !== 'discover_devices' && !manuallyReloadedViews[view]) {
        manuallyReloadedViews[view] = true;
        
        // Just refresh discovery results and rely on HTML page's onload
        try {
          // Clear existing discovery results to ensure fresh data
          this.discoveryResults = {};
          
          // Get fresh discovery results
          const currentResults = this.discoveryStrategy.getDiscoveryResults();
          const resultIds = Object.keys(currentResults);
          
          // Process each discovery result again to ensure fresh data
          for (const id of resultIds) {
            const result = currentResults[id];
            this.onDiscoveryResult(result);
          }
        } catch (error) {
          this.error('Error refreshing discovery results:', error);
        }
      }
      
      // Special handling for discover_devices view
      if (view === 'discover_devices') {
        const now = Date.now();
        
        // Refresh discovery results with throttling (max once per second)
        if (now - lastDiscoveryRefresh > 1000) {
          lastDiscoveryRefresh = now;
          
          try {
            // Get fresh discovery results
            const currentResults = this.discoveryStrategy.getDiscoveryResults();
            const resultIds = Object.keys(currentResults);
            
            // Process each discovery result
            for (const id of resultIds) {
              const result = currentResults[id];
              this.onDiscoveryResult(result);
            }
              
          } catch (error) {
            this.error('Error refreshing discovery results:', error);
          }
        }
      }
    });

    // Handler for complete discovery strategy refresh
    session.setHandler('refresh_discovery_strategy', async () => {
      this.log('Refreshing discovery results');
      
      try {
        // Clear existing discovery results first
        this.discoveryResults = {};
        
        // Get fresh discovery results
        const currentResults = this.discoveryStrategy.getDiscoveryResults();
        const resultIds = Object.keys(currentResults);
        this.log(`Found ${resultIds.length} devices in discovery refresh`);
        
        // Process each discovery result
        for (const id of resultIds) {
          const result = currentResults[id];
          this.onDiscoveryResult(result);
        }
        
        // Return success
        return true;
      } catch (error) {
        this.error('Error during discovery refresh:', error);
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
      pairingDevice = device;
      return true;
    });

    // Get the pairing device on the add_device page
    session.setHandler('get_pairing_device', async () => {
      if (pairingDevice) {
        return pairingDevice;
      }
      
      this.error('No device selected for pairing');
      return null;
    });

    // Handler for discover_devices view to list discovered devices 
    session.setHandler('list_devices', async () => {
      
      try {
        // Clear existing discovery results to ensure fresh data
        this.discoveryResults = {};
        
        // Get fresh discovery results
        const currentResults = this.discoveryStrategy.getDiscoveryResults();
        const resultIds = Object.keys(currentResults);
        
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
      
      if (discoveryResults.length === 0) {
        this.log('No devices found in discovery');
      }
      
      const devices = [];
      
      // Process each discovery result
      for (const discoveryResult of discoveryResults) {
        if (discoveryResult && discoveryResult.address) {
          try {
            const deviceInfo = await this.getDeviceInfo(discoveryResult.address);
            devices.push(deviceInfo);
          } catch (error) {
            // Skip devices with errors
            this.error(`Error getting info for ${discoveryResult.address}: ${error.message}`);
          }
        }
      }
      
      this.log(`Returning ${devices.length} devices for pairing`);
      
      return devices;
    });
  }
}

module.exports = WLEDDriver;