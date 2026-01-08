export class CreateAuthorizedNumberDto {
  phoneNumber: string;
  dni?: string;
  firstName?: string;
  lastName?: string;
  entityName?: string;
  position?: string;
  canSendExcel?: boolean;
  canRequestInfo?: boolean;
}

export class UpdateAuthorizedNumberDto {
  phoneNumber?: string;
  dni?: string;
  firstName?: string;
  lastName?: string;
  entityName?: string;
  position?: string;
  canSendExcel?: boolean;
  canRequestInfo?: boolean;
}

