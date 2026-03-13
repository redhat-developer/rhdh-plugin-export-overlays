export class RolesPage {
  static getRolesListCellsIdentifier() {
    const roleName = new RegExp(/^(role|user|group):[a-zA-Z]+\/[\w@*.~-]+$/);
    const usersAndGroups = new RegExp(
      /^(1\s(user|group)|[2-9]\s(users|groups))(, (1\s(user|group)|[2-9]\s(users|groups)))?$/,
    );
    const permissionPolicies = /\d/;
    return [roleName, usersAndGroups, permissionPolicies];
  }

  static getUsersAndGroupsListCellsIdentifier() {
    const name = new RegExp(/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/);
    const type = new RegExp(/^(User|Group)$/);
    const members = /^(-|\d+)$/;
    return [name, type, members];
  }

  static getPermissionPoliciesListCellsIdentifier() {
    const policies =
      /^(?:(Read|Create|Update|Delete)(?:, (?:Read|Create|Update|Delete))*|Use)$/;
    return [policies];
  }

  //Depending on the version of the Backstage, it can be 'Permission Policies' or 'Accessible Plugins'
  // Accepts either term
  static getRolesListColumnsText() {
    return [
      /^Name$/,
      /^Users and groups$/,
      /Permission Policies|Accessible plugins/,
    ];
  }

  static getUsersAndGroupsListColumnsText() {
    return ["Name", "Type", "Members"];
  }

  static getPermissionPoliciesListColumnsText() {
    return ["Plugin", "Permission", "Policies"];
  }
}
