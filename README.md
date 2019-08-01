configured-rabbitmq-client
==========================
A small wrapper around the rabbot to allow configuration from confit.

## Persistent messages
exchanges and queues are `durable` by default. You can make messages persistent in an exchangeGroup (primary, retry and rejected) by doing the following:
```
{
  "exchangeGroups": {
    "exchange.test.request.v1": {
      "persistent": true,
      "keys": "exchange.test"
    }
  }
} 
```

 Follow [this link](https://github.com/gas-buddy/wiki/wiki/Persistent-rabbitMQ-messages) to see more options

