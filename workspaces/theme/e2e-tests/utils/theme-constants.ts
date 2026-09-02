type ThemeInfo = {
  name: string;
  primaryColor: string;
  appBarBackgroundColor: string;
};

export class ThemeConstants {
  static getThemes() {
    const light: ThemeInfo = {
      name: "Light",
      primaryColor: "#2A61A7",
      appBarBackgroundColor: "rgb(216, 98, 208)",
    };

    const dark: ThemeInfo = {
      name: "Dark",
      primaryColor: "#DC6ED9",
      appBarBackgroundColor: "rgb(190, 122, 45)",
    };

    const qeLight: ThemeInfo = {
      name: "RHDH Plugins QE Light",
      primaryColor: "rgb(255, 95, 21)",
      appBarBackgroundColor: "",
    };

    const qeDark: ThemeInfo = {
      name: "RHDH Plugins QE Dark",
      primaryColor: "#ab75cf",
      appBarBackgroundColor: "",
    };

    return [light, dark, qeLight, qeDark];
  }
}
