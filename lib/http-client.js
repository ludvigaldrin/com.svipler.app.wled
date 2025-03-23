'use strict';

const axios = require('axios');

class HttpClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl;
    this.timeout = options.timeout || 5000; // 5 second default, configurable
  }

  async get(endpoint) {
    try {
      const url = this._buildUrl(endpoint);
      const response = await axios.get(url, {
        timeout: this.timeout,
        headers: {
          'Accept': 'application/json',
        }
      });
      return response.data;
    } catch (error) {
      this._handleError(error);
    }
  }

  async post(endpoint, data) {
    try {
      const url = this._buildUrl(endpoint);
      const response = await axios.post(url, data, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        }
      });
      return response.data;
    } catch (error) {
      this._handleError(error);
    }
  }

  async put(endpoint, data) {
    try {
      const url = this._buildUrl(endpoint);
      const response = await axios.put(url, data, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        }
      });
      return response.data;
    } catch (error) {
      this._handleError(error);
    }
  }

  _buildUrl(endpoint) {
    // Handle both cases where endpoint starts with / or not
    const formattedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${this.baseUrl}${formattedEndpoint}`;
  }

  _handleError(error) {
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      throw new Error(`Request failed with status ${error.response.status}: ${error.response.data}`);
    } else if (error.request) {
      // The request was made but no response was received
      throw new Error(`No response received: ${error.message}`);
    } else {
      // Something happened in setting up the request that triggered an Error
      throw new Error(`Request error: ${error.message}`);
    }
  }
}

module.exports = { HttpClient }; 