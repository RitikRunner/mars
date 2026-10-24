import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Param,
  ServiceUnavailableException,
  NotFoundException,
} from '@nestjs/common';

@Controller('mock')
export class MockController {
  private erpOnline = true;
  private readonly ordersMap = new Map<string, any>();

  @Get('erp/salesOrders')
  getSalesOrder(@Query('externalDocumentNumber') externalDocNo: string) {
    if (!this.erpOnline) {
      throw new ServiceUnavailableException('Microsoft Business Central is offline for Sunday maintenance');
    }
    const order = this.ordersMap.get(externalDocNo);
    if (!order) {
      throw new NotFoundException(`Order with externalDocumentNumber ${externalDocNo} not found`);
    }
    return order;
  }

  @Post('erp/salesOrders')
  handleErpSalesOrder(@Body() body: any) {
    if (!this.erpOnline) {
      throw new ServiceUnavailableException('Microsoft Business Central is offline for Sunday maintenance');
    }
    const externalDocNo = body.externalDocumentNumber || `${body.channel}-${body.externalOrderId}`;
    const existing = this.ordersMap.get(externalDocNo);
    if (existing) {
      return existing;
    }

    const orderData = {
      no: `BC-ORD-${Date.now()}`,
      externalDocumentNumber: externalDocNo,
      status: 'CONFIRMED',
      payload: body,
      createdAt: new Date().toISOString(),
    };
    this.ordersMap.set(externalDocNo, orderData);
    return orderData;
  }

  @Post('erp/salesOrders/:externalDocNo/cancel')
  handleCancelSalesOrder(@Param('externalDocNo') externalDocNo: string) {
    if (!this.erpOnline) {
      throw new ServiceUnavailableException('Microsoft Business Central is offline for Sunday maintenance');
    }
    const order = this.ordersMap.get(externalDocNo);
    if (order) {
      order.status = 'CANCELLED';
    }
    return { success: true, externalDocumentNumber: externalDocNo };
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
