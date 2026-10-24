import { Controller, Post, Body, Get } from '@nestjs/common';

@Controller('mock')
export class MockController {
  private erpOnline = true;

  @Post('erp/salesOrders')
  handleErpSalesOrder(@Body() body: any) {
    if (!this.erpOnline) {
      return { status: 503, message: 'Microsoft Business Central is offline for Sunday maintenance' };
    }
    return {
      status: 201,
      no: `BC-ORD-${Date.now()}`,
      externalDocumentNumber: body.externalOrderId,
    };
  }

  @Post('erp/toggle-maintenance')
  toggleMaintenance() {
    this.erpOnline = !this.erpOnline;
    return { erpOnline: this.erpOnline };
  }

  @Get('erp/status')
  getErpStatus() {
    return { erpOnline: this.erpOnline };
  }
}
